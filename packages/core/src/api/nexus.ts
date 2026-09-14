import type { ConnectionManager } from "@/connection/connection-manager";
import type { LogicalConnection } from "@/connection/logical-connection";
import {
  ConnectionHandle,
  type Connection,
  ConnectionCollection,
} from "./connection";
import type { ConnectOptions, ConnectMulticastOptions } from "./types/config";
import type { ConnectionWhere } from "@/types/adapter-model";
import { safeCall } from "@/service/proxy-factory";
import {
  NexusConfigurationError,
  type ConnectionAcquireError,
  NexusUsageError,
  type NexusCallError,
} from "@/errors";
import { Engine } from "@/service/engine";
import type { AdapterModel, ContextMetaOf } from "@/types/adapter-model";
import { REF_WRAPPER_SYMBOL, type RefWrapper } from "@/types/ref-wrapper";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import {
  getProxyStatus,
  inspectProxy,
  subscribeProxyStatus,
  type ProxyStatus,
  type ProxyDebugSnapshot,
} from "../service/proxy-lifecycle.js";
import { Result } from "better-result";
import { toSerializedError } from "@/utils/error";
const { err, ok } = Result;
import { createEndpointDecorator } from "./decorators/endpoint";
import { createExposeDecorator } from "./decorators/expose";
import { buildKernel } from "./kernel";
import { InstanceDecoratorRegistry, type DecoratorSnapshot } from "./registry";
import { safeConnect, safeConnectMulticast } from "./acquire";
import { isPlainTarget, Token } from "./token";
import type { RemoteValue, NexusInstance } from "./types";
import {
  composeNexusConfig,
  snapshotConfig,
  isValidTimeout,
  type AuthorizationPolicy,
  type NexusConfig,
  type ServiceProvider,
} from "./types/config";

type Lifecycle =
  | "draft"
  | "scheduled"
  | "snapshotting"
  | "bootstrapping"
  | "ready"
  | "failed";

/** Defers bootstrap one turn so synchronous configuration and decorators share one snapshot. */
const defer = (work: () => Promise<void>): Promise<void> =>
  new Promise((resolve, reject) =>
    setTimeout(() => work().then(resolve, reject), 0),
  );

/** Converts a safe result only at the public throw-style boundary. */
const unwrapResultOrThrow = <T>(result: Result<T, Error>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

/** Preserves the safe operation's error identity for an asynchronous throw-style API. */
const unwrapResultPromiseOrThrow = async <T>(
  result: Promise<Result<T, Error>>,
): Promise<T> => unwrapResultOrThrow(await result);

export class Nexus<
  M extends AdapterModel = AdapterModel,
> implements NexusInstance<M> {
  /** Consumes one genuine lazy operation, sharing execution with await and returning its RPC Result. */
  public static safeCall<T, M extends AdapterModel>(
    value: RemoteValue<T, M>,
  ): Promise<Result<T, NexusCallError>> {
    return safeCall(value);
  }
  /**
   * Returns the cached status of an exact ordinary unicast root proxy.
   *
   * @throws {NexusUsageError} If `proxy` is not a root created by this Core copy.
   */
  public static getProxyStatus(proxy: object): ProxyStatus {
    return getProxyStatus(proxy);
  }

  /**
   * Subscribes to status snapshots of an exact ordinary unicast root.
   * The listener synchronously receives the current snapshot, then each distinct
   * future snapshot.
   *
   * @throws {NexusUsageError} If `proxy` is not a root created by this Core copy.
   */
  public static subscribeProxyStatus(
    proxy: object,
    listener: (status: ProxyStatus) => void,
  ): () => void {
    return subscribeProxyStatus(proxy, listener);
  }

  /**
   * Returns cached diagnostics for an exact ordinary unicast root proxy.
   *
   * @throws {NexusUsageError} If `proxy` is not a root created by this Core copy.
   */
  public static inspectProxy(proxy: object): ProxyDebugSnapshot {
    return inspectProxy(proxy);
  }

  /** Releases a remote reference without invoking business stop or unsubscribe methods. */
  public static release(proxy: object): void {
    unwrapResultOrThrow(Nexus.safeRelease(proxy));
  }

  /** Captures release failures without closing the capability's shared session. */
  public static safeRelease(proxy: object): Result<void, Error> {
    return safeReleaseProxyCapability(proxy);
  }
  private readonly decoratorRegistry = new InstanceDecoratorRegistry();
  private config: NexusConfig<M> = {};
  private engine: Engine<M> | null = null;
  private connectionManager: ConnectionManager<M> | null = null;
  private initialization: Promise<void> | null = null;
  private failure: Error | null = null;
  private lifecycle: Lifecycle = "draft";
  private readonly connections = new Map<string, ConnectionHandle<M>>();
  private readonly connectionObservers = new Set<() => void>();

  /** Reuses one public handle per logical session, independently of the acquiring caller. */
  private connection(session: LogicalConnection<M>): Connection<M> {
    let handle = this.connections.get(session.connectionId);
    if (!handle) {
      handle = new ConnectionHandle(
        session,
        this.engine!,
        this.config.callTimeout ?? 5_000,
      );
      this.connections.set(session.connectionId, handle);
    }
    return handle;
  }

  /** Observes every current or future ready session once without initiating bootstrap or dialing. */
  public onConnect(listener: (connection: Connection<M>) => void): () => void;
  /** Observes each session when it first matches the predicate. */
  public onConnect(
    where: ConnectionWhere<M>,
    listener: (connection: Connection<M>) => void,
  ): () => void;
  /** Installs gap-free initial and future delivery with a separate seen set per registration. */
  public onConnect(
    whereOrListener: ConnectionWhere<M> | ((connection: Connection<M>) => void),
    listener?: (connection: Connection<M>) => void,
  ): () => void {
    const where = listener
      ? (whereOrListener as ConnectionWhere<M>)
      : undefined;
    const receive =
      listener ?? (whereOrListener as (connection: Connection<M>) => void);
    const seen = new WeakSet<LogicalConnection<M>>();
    let active = true;
    /** Rechecks readiness immediately before delivery and isolates each observer failure. */
    const scan = () => {
      for (const session of this.connectionManager?.findReadyConnections() ??
        []) {
        if (!active || seen.has(session)) continue;
        Result.try({
          try: () => {
            if (
              where &&
              !where(session.remoteIdentity!, session.context.connection)
            )
              return;
            if (!active || !session.isReady()) return;
            seen.add(session);
            receive(this.connection(session));
          },
          catch: (error) => error,
        }).match({
          ok: () => undefined,
          err: (error) =>
            console.error("Nexus connection observer failed", error),
        });
      }
    };
    this.connectionObservers.add(scan);
    scan();
    return () => {
      active = false;
      this.connectionObservers.delete(scan);
    };
  }

  /** Acquires one shared ready session; absent target means passive waiting without dialing. */
  public connect(options: ConnectOptions<M> = {}): Promise<Connection<M>> {
    return unwrapResultPromiseOrThrow(this.safeConnect(options));
  }

  /** Returns structured acquisition failures while retaining runtime-owned connection work. */
  public async safeConnect(
    options: ConnectOptions<M> = {},
  ): Promise<Result<Connection<M>, ConnectionAcquireError>> {
    const acquired = await safeConnect(() => this.safeReadyManager(), options);
    return acquired.map((session) => this.connection(session));
  }

  /** Acquires all explicit targets or a fixed snapshot of currently matching ready sessions. */
  public connectMulticast(
    options: ConnectMulticastOptions<M> = {},
  ): Promise<ConnectionCollection<M>> {
    return unwrapResultPromiseOrThrow(this.safeConnectMulticast(options));
  }

  /** Returns the first definite target failure rather than silently dropping failed members. */
  public async safeConnectMulticast(
    options: ConnectMulticastOptions<M> = {},
  ): Promise<Result<ConnectionCollection<M>, ConnectionAcquireError>> {
    const acquired = await safeConnectMulticast(
      () => this.safeReadyManager(),
      options,
    );
    return acquired.map(
      (sessions) =>
        new ConnectionCollection(
          sessions.map((session) => this.connection(session)),
        ),
    );
  }

  public readonly Expose = createExposeDecorator(
    this.decoratorRegistry,
  ) as NexusInstance<M>["Expose"];
  public readonly Endpoint = createEndpointDecorator(
    this.decoratorRegistry,
  ) as NexusInstance<M>["Endpoint"];

  /** Adds bootstrap configuration and schedules initialization after the current synchronous turn. */
  public configure<const T extends NexusConfig<M>>(
    config: T,
  ): NexusInstance<M> {
    return unwrapResultOrThrow(this.safeConfigure(config));
  }

  /** Validates configuration and lifecycle locks without changing an already initialized runtime. */
  public safeConfigure<const T extends NexusConfig<M>>(
    config: T,
  ): Result<NexusInstance<M>, Error> {
    if (!isObject(config))
      return err(
        new NexusUsageError(
          "Nexus: Invalid configure() input.",
          "E_USAGE_INVALID",
        ),
      );
    if (!isValidTimeout(config.callTimeout))
      return err(
        new NexusUsageError("callTimeout must be positive and finite."),
      );
    if (
      config.endpoint?.connectTo !== undefined &&
      (!Array.isArray(config.endpoint.connectTo) ||
        !Array.from(config.endpoint.connectTo).every(isPlainTarget))
    ) {
      return err(
        new NexusUsageError(
          "Nexus: endpoint.connectTo must be an array of plain exact targets.",
          "E_USAGE_INVALID",
        ),
      );
    }
    if (
      this.lifecycle === "snapshotting" ||
      this.lifecycle === "bootstrapping"
    ) {
      return err(
        new NexusConfigurationError(
          "Nexus: configure() cannot be called during bootstrapping.",
          "E_NEXUS_BOOTSTRAPPING_LOCKED",
        ),
      );
    }
    if (this.lifecycle === "failed") return err(this.failure!);
    if (this.lifecycle === "ready" && isStructuralConfig(config)) {
      return err(
        new NexusConfigurationError(
          "Nexus: structural configure() cannot be called after ready. Use updateIdentity() for endpoint meta changes.",
          "E_NEXUS_ALREADY_READY",
        ),
      );
    }
    this.config = composeNexusConfig([this.config, config]);
    this.scheduleInitialization();
    return ok(this);
  }

  /** Registers an object provider before bootstrap or publishes it live after readiness. */
  public provide<T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): this;
  /** Registers a provider descriptor while preserving the service object's identity. */
  public provide(registration: ServiceProvider<object, M>): this;
  /** Registers a batch through the same validation and publication boundary. */
  public provide(registrations: readonly ServiceProvider<object, M>[]): this;
  /** Normalizes registration overloads and throws only at this public boundary. */
  public provide<T extends object>(
    input:
      | Token<T>
      | Token<T, M>
      | ServiceProvider<T, M>
      | readonly ServiceProvider<object, M>[],
    service?: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): this {
    const result = this.safeProvideNormalized(
      this.normalizeProviders(input, service, options),
    );
    return unwrapResultOrThrow(result);
  }

  /** Returns provider registration failures without throwing expected validation errors. */
  public safeProvide<T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): Result<this, Error>;
  /** Registers one descriptor while preserving implementation identity. */
  public safeProvide(
    registration: ServiceProvider<object, M>,
  ): Result<this, Error>;
  /** Validates and registers a batch through the same lifecycle boundary. */
  public safeProvide(
    registrations: readonly ServiceProvider<object, M>[],
  ): Result<this, Error>;
  /** Dispatches supported registration forms to one safe batch implementation. */
  public safeProvide<T extends object>(
    input:
      | Token<T>
      | Token<T, M>
      | ServiceProvider<T, M>
      | readonly ServiceProvider<object, M>[],
    service?: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): Result<this, Error> {
    const providers = this.normalizeProviders(input, service, options);
    return this.safeProvideNormalized(providers);
  }
  /** Converts supported provider overloads to the shared registration batch. */
  private normalizeProviders<T extends object>(
    input:
      | Token<T>
      | Token<T, M>
      | ServiceProvider<T, M>
      | readonly ServiceProvider<object, M>[],
    service?: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): readonly ServiceProvider<object, M>[] {
    if (isProviderList<M>(input)) return input;
    if (isProvider<M>(input)) return [input];
    return [{ token: input, service: service!, policy: options?.policy }];
  }
  /** Applies registration-window rules before storing or publishing an entire provider batch. */
  private safeProvideNormalized(
    providers: readonly ServiceProvider<object, M>[],
  ): Result<this, Error> {
    if (this.lifecycle === "snapshotting" || this.lifecycle === "bootstrapping")
      return err(
        new NexusConfigurationError(
          "Nexus: provider registration window is closed during bootstrapping.",
          "E_NEXUS_BOOTSTRAPPING_LOCKED",
        ),
      );
    if (this.lifecycle === "failed") return err(this.failure!);
    if (
      providers.some(
        (provider) =>
          !provider.token || !provider.token.id || !provider.service,
      )
    )
      return err(
        new NexusConfigurationError(
          "Nexus: provider batch registration failed validation.",
          "E_PROVIDER_BATCH_INVALID",
        ),
      );
    if (this.lifecycle === "ready" && this.engine) {
      const result = this.engine.safeProvideServicesBatch(
        Object.fromEntries(
          providers.map((provider) => [
            provider.token.id,
            { service: provider.service, policy: provider.policy },
          ]),
        ),
      );
      return result.isErr() ? err(result.error) : ok(this);
    }
    this.config = composeNexusConfig([
      this.config,
      { providers: [...providers] },
    ]);
    return ok(this);
  }

  /** Waits for local runtime readiness, not for startup targets or remote business services. */
  public ready(): Promise<void> {
    return unwrapResultPromiseOrThrow(this.safeReady());
  }
  /** Returns local bootstrap failure without starting a separate initialization attempt. */
  public async safeReady(): Promise<Result<void, Error>> {
    return (await this.safeReadyManager()).map(() => undefined);
  }

  /** Publishes local identity updates after earlier provider publications on each live session. */
  public updateIdentity(updates: Partial<ContextMetaOf<M>>): Promise<void> {
    return unwrapResultPromiseOrThrow(this.safeUpdateIdentity(updates));
  }
  /** Validates identity input and returns publication failures at the runtime boundary. */
  public async safeUpdateIdentity(
    updates: Partial<ContextMetaOf<M>>,
  ): Promise<Result<void, Error>> {
    if (!isObject(updates))
      return err(
        new NexusUsageError(
          "Nexus: Invalid updateIdentity() input.",
          "E_USAGE_INVALID",
        ),
      );
    return (await this.safeReadyManager()).andThen((manager) =>
      manager.safeUpdateLocalIdentity(updates),
    );
  }
  /** Marks an object for reference transfer; no remote resource is allocated until encoding. */
  public ref<T extends object>(target: T): RefWrapper<T> {
    return unwrapResultOrThrow(this.safeRef(target));
  }
  /** Returns a reference marker or an invalid-value error without initiating transport work. */
  public safeRef<T extends object>(target: T): Result<RefWrapper<T>, Error> {
    return !target || typeof target !== "object"
      ? err(new NexusUsageError("Nexus.ref() can only be used with objects."))
      : ok({ [REF_WRAPPER_SYMBOL]: true, target });
  }
  /** Releases a remote reference independently of the instance that created its handle. */
  public release(proxy: object): void {
    unwrapResultOrThrow(this.safeRelease(proxy));
  }
  /** Captures reference-release failures without invoking business cleanup. */
  public safeRelease(proxy: object): Result<void, Error> {
    return safeReleaseProxyCapability(proxy);
  }

  /** Owns the single bootstrap task and installs L4 observers after L3 cleanup wiring. */
  private scheduleInitialization(): void {
    if (this.initialization) return;
    this.lifecycle = "scheduled";
    this.initialization = defer(async () => {
      this.lifecycle = "snapshotting";
      const snapshot = this.snapshot();
      const kernelResult = await buildKernel<M>(
        snapshot.config,
        snapshot.decorators.providers,
        snapshot.decorators.endpoint,
        {
          onDisconnect: (id) => {
            this.connections.get(id)?.closed();
            this.connections.delete(id);
          },
          onIdentityUpdated: (id, next) =>
            this.connections.get(id)?.identityUpdated(next),
        },
        (id) =>
          this.connections.get(id) ??
          this.connection(this.connectionManager!.connections.get(id)!),
      );
      const kernel = unwrapResultOrThrow(kernelResult);
      this.lifecycle = "bootstrapping";
      this.engine = kernel.engine;
      this.connectionManager = kernel.connectionManager;
      unwrapResultOrThrow(await this.connectionManager.safeInitialize());
      this.connectionManager.subscribeAvailabilityChanged(() => {
        for (const observer of this.connectionObservers) observer();
      });
      this.lifecycle = "ready";
      for (const observer of this.connectionObservers) observer();
    }).catch((error) => {
      this.failure =
        error instanceof NexusConfigurationError
          ? error
          : new NexusConfigurationError(
              "Nexus bootstrap failed.",
              "E_NEXUS_BOOTSTRAP_FAILED",
              { cause: toSerializedError(error) },
            );
      this.lifecycle = "failed";
      throw this.failure;
    });
  }

  /** Captures mutable bootstrap data while preserving provider and endpoint capability identity. */
  private snapshot(): {
    config: NexusConfig<M>;
    decorators: DecoratorSnapshot<M>;
  } {
    const decorators =
      this.decoratorRegistry.snapshot() as DecoratorSnapshot<M>;
    return {
      config: snapshotConfig(this.config),
      decorators,
    };
  }
  /** Lazily waits for the shared bootstrap and exposes only the ready acquisition dependency. */
  private async safeReadyManager(): Promise<
    Result<ConnectionManager<M>, Error>
  > {
    if (this.lifecycle === "failed") return err(this.failure!);
    this.scheduleInitialization();
    const initialized = await Result.tryPromise({
      try: () => this.initialization!,
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });
    return initialized.andThen(() =>
      this.engine && this.connectionManager
        ? ok(this.connectionManager)
        : err(
            this.failure ??
              new NexusConfigurationError("Nexus initialization failed."),
          ),
    );
  }
}

/** Distinguishes object inputs from missing values and arrays at public configuration boundaries. */
const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Invokes an available release capability and contains arbitrary user-controlled throws. */
function safeReleaseProxyCapability(proxy: object): Result<void, Error> {
  return Result.try({
    try: () => {
      if ((typeof proxy === "object" && proxy) || typeof proxy === "function") {
        const release = (proxy as { [RELEASE_PROXY_SYMBOL]?: unknown })[
          RELEASE_PROXY_SYMBOL
        ];
        if (typeof release === "function") release();
      }
    },
    catch: asReleaseError,
  });
}
/** Recognizes the descriptor overload without inspecting a service's implementation. */
const isProvider = <M extends AdapterModel>(
  value: unknown,
): value is ServiceProvider<object, M> =>
  isObject(value) && "token" in value && "service" in value;
/** Recognizes the batch overload; individual entries are validated at registration. */
const isProviderList = <M extends AdapterModel>(
  value: unknown,
): value is readonly ServiceProvider<object, M>[] => Array.isArray(value);
/** Detects changes that would mutate the immutable bootstrap topology or call policy. */
const isStructuralConfig = <M extends AdapterModel>(
  config: NexusConfig<M>,
): boolean =>
  Object.hasOwn(config, "providers") ||
  Object.hasOwn(config, "callTimeout") ||
  Object.hasOwn(config, "policy") ||
  Object.hasOwn(config, "endpoint");
/** Converts hostile thrown values without allowing diagnostic inspection to throw again. */
const asReleaseError = (value: unknown): Error => {
  try {
    if (value instanceof Error) return value;
  } catch {
    return new Error("Unknown error");
  }
  try {
    return new Error(String(value));
  } catch {
    return new Error("Unknown error");
  }
};
export const nexus = new Nexus();

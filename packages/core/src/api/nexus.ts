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
import type { Engine } from "@/service/engine";
import type { AdapterModel, ContextMetaOf } from "@/types/adapter-model";
import { REF_WRAPPER_SYMBOL, type RefWrapper } from "@/types/ref-wrapper";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { Result } from "better-result";
import { createEvtChannel } from "@/utils/evt-channel";
import { toSerializedError } from "@/utils/error";
const { err, ok } = Result;
import {
  createEndpointDecorator,
  type EndpointRegistration,
} from "./decorators/endpoint";
import {
  createExposeDecorator,
  type ServiceRegistration,
} from "./decorators/expose";
import { buildKernel } from "./kernel";
import { safeConnect, safeConnectMulticast } from "./acquire";
import { isPlainTarget, Token } from "./token";
import type { RemoteValue, NexusInstance, ProviderArgs } from "./types";
import {
  composeNexusConfig,
  snapshotConfig,
  snapshotEndpoint,
  isValidTimeout,
  validateProviderBatch,
  type NexusConfig,
  type ServiceProvider,
} from "./types/config";

type Lifecycle<M extends AdapterModel> =
  | { phase: "draft" | "starting" }
  | {
      phase: "listening" | "ready";
      engine: Engine<M>;
      manager: ConnectionManager<M>;
    }
  | { phase: "failed"; error: Error };

/** Defers bootstrap one turn so synchronous configuration and decorators share one snapshot. */
const defer = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

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
  // ===== Bootstrap State =====
  private readonly serviceDeclarations = new Map<string, ServiceRegistration>();
  private endpointDeclaration: EndpointRegistration<M> | null = null;
  private config: NexusConfig<M> = {};
  private lifecycle: Lifecycle<M> = { phase: "draft" };
  private initialization: Promise<Result<ConnectionManager<M>, Error>> | null =
    null;

  // ===== Handles And Channels =====
  private readonly connections = new WeakMap<
    LogicalConnection<M>,
    ConnectionHandle<M>
  >();
  private readonly readyChanel = createEvtChannel<ConnectionManager<M>>();

  // ===== Decorators =====
  public readonly Expose = createExposeDecorator((registration) => {
    this.assertDeclarationWindow();
    const id = registration.token.id;
    if (this.serviceDeclarations.has(id))
      throw new NexusConfigurationError(
        `Nexus: Provider for token ID "${id}" has already been registered on this Nexus instance.`,
        "E_DUPLICATE_PROVIDER",
        { token: id },
      );
    this.serviceDeclarations.set(id, registration);
  }) as NexusInstance<M>["Expose"];
  public readonly Endpoint = createEndpointDecorator((registration) => {
    this.assertDeclarationWindow();
    if (this.endpointDeclaration)
      throw new NexusConfigurationError(
        "Nexus: @Endpoint decorator has already been registered on this Nexus instance.",
        "E_ENDPOINT_SOURCE_CONFLICT",
      );
    this.endpointDeclaration = registration as EndpointRegistration<M>;
  }) as NexusInstance<M>["Endpoint"];

  // ===== Static API =====
  /** Consumes one genuine lazy operation, sharing execution with await and returning its RPC Result. */
  public static safeCall<T, M extends AdapterModel>(
    value: RemoteValue<T, M>,
  ): Promise<Result<T, NexusCallError>> {
    return safeCall(value);
  }
  /** Releases a remote reference without invoking business stop or unsubscribe methods. */
  public static release(proxy: object): void {
    unwrapResultOrThrow(Nexus.safeRelease(proxy));
  }

  /** Captures release failures without closing the capability's shared session. */
  public static safeRelease(proxy: object): Result<void, Error> {
    return Result.try({
      try: () => {
        if (
          (typeof proxy === "object" && proxy) ||
          typeof proxy === "function"
        ) {
          const release = (proxy as { [RELEASE_PROXY_SYMBOL]?: unknown })[
            RELEASE_PROXY_SYMBOL
          ];
          if (typeof release === "function") release();
        }
      },
      catch: asReleaseError,
    });
  }

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
    return Result.try({
      try: (): Result<NexusInstance<M>, Error> => {
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
        if (config.endpoint !== undefined && !isObject(config.endpoint)) {
          return err(
            new NexusUsageError("endpoint must be a configuration object."),
          );
        }
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
          this.lifecycle.phase === "starting" ||
          this.lifecycle.phase === "listening"
        ) {
          return err(
            new NexusConfigurationError(
              "Nexus: configure() cannot be called during bootstrapping.",
              "E_NEXUS_BOOTSTRAPPING_LOCKED",
            ),
          );
        }
        if (this.lifecycle.phase === "failed") return err(this.lifecycle.error);
        if (this.lifecycle.phase === "ready" && isStructuralConfig(config)) {
          return err(
            new NexusConfigurationError(
              "Nexus: structural configure() cannot be called after ready. Use updateIdentity() for endpoint meta changes.",
              "E_NEXUS_ALREADY_READY",
            ),
          );
        }
        const providersValid = validateProviderBatch(
          config.providers === undefined ? [] : config.providers,
        );
        if (providersValid.isErr()) return providersValid;
        this.config = composeNexusConfig([this.config, config]);
        void this.safeReadyManager();
        return ok(this);
      },
      catch: (error) =>
        new NexusUsageError(
          "Nexus: Invalid configure() input.",
          "E_USAGE_INVALID",
          { cause: toSerializedError(error) },
        ),
    }).andThen((result) => result);
  }

  /** Registers an object provider before bootstrap or publishes it live after readiness. */
  public provide<T extends object>(...args: ProviderArgs<T, M>): this {
    return unwrapResultOrThrow(this.safeProvide(...args));
  }

  /** Validates one submission before composing declarations or publishing live services. */
  public safeProvide<T extends object>(
    ...[input, service, options]: ProviderArgs<T, M>
  ): Result<this, Error> {
    return Result.try({
      try: (): Result<this, Error> => {
        if (
          this.lifecycle.phase === "starting" ||
          this.lifecycle.phase === "listening"
        )
          return err(
            new NexusConfigurationError(
              "Nexus: provider registration window is closed during bootstrapping.",
              "E_NEXUS_BOOTSTRAPPING_LOCKED",
            ),
          );
        if (this.lifecycle.phase === "failed") return err(this.lifecycle.error);
        let providers: readonly ServiceProvider<object, M>[];
        if (Array.isArray(input)) providers = input;
        else if (isProvider<M>(input)) providers = [input];
        else
          providers = [
            {
              token: input as Token<T, M>,
              service: service!,
              policy: options?.policy,
            },
          ];
        const valid = validateProviderBatch(providers);
        if (valid.isErr()) return valid;
        if (this.lifecycle.phase === "ready") {
          this.lifecycle.engine.provideServices(
            providers.map(({ token, service, policy }) => ({
              name: token.id,
              service,
              policy,
            })),
          );
          return ok(this);
        }
        this.config = composeNexusConfig([
          this.config,
          { providers: [...providers] },
        ]);
        return ok(this);
      },
      catch: (error) =>
        new NexusConfigurationError(
          "Nexus: provider batch registration failed validation.",
          "E_PROVIDER_BATCH_INVALID",
          { cause: toSerializedError(error) },
        ),
    }).andThen((result) => result);
  }

  // ===== Public Observation And Acquisition =====
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
    /** Recheck after the predicate because it may close the session or unsubscribe. */
    const deliver = (session: LogicalConnection<M>) => {
      try {
        if (!active || seen.has(session) || !session.isReady()) return;
        if (
          where &&
          !where(session.remoteIdentity!, session.context.connection)
        )
          return;
        if (!active || !session.isReady()) return;
        seen.add(session);
        receive(this.connection(session));
      } catch (error) {
        console.error("Nexus connection observer failed", error);
      }
    };
    // One registration owns one upstream subscription: bootstrap first, then
    // manager availability. Transfer ownership before initial delivery can reenter.
    let stop: (() => void) | undefined;
    const observe = (manager: ConnectionManager<M>) => {
      if (!active) return;
      stop?.();
      stop = manager.subscribeAvailabilityChanged(deliver);
      for (const session of manager.findReadyConnections()) deliver(session);
    };
    if (this.lifecycle.phase === "ready") observe(this.lifecycle.manager);
    else if (this.lifecycle.phase !== "failed")
      stop = this.readyChanel[0](observe);
    return () => {
      active = false;
      stop?.();
      stop = undefined;
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
    const acquired = await safeConnect<M, LogicalConnection<M>>(
      () => this.safeReadyManager(),
      options,
    );
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
    const acquired = await safeConnectMulticast<M, LogicalConnection<M>>(
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

  // ===== Public Lifecycle And Resources =====
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
    return Nexus.safeRelease(proxy);
  }

  // ===== Private Orchestration =====
  /** Decorators declare bootstrap topology and cannot become silently ignored live writes. */
  private assertDeclarationWindow(): void {
    if (this.lifecycle.phase === "failed") throw this.lifecycle.error;
    if (this.lifecycle.phase !== "draft") {
      throw new NexusConfigurationError(
        "Nexus: decorator registration is closed after bootstrap begins.",
        this.lifecycle.phase === "ready"
          ? "E_NEXUS_ALREADY_READY"
          : "E_NEXUS_BOOTSTRAPPING_LOCKED",
      );
    }
  }

  /** Reuses one public handle per logical session, independently of the acquiring caller. */
  private connection(session: LogicalConnection<M>): Connection<M> {
    let handle = this.connections.get(session);
    if (!handle) {
      if (
        this.lifecycle.phase !== "listening" &&
        this.lifecycle.phase !== "ready"
      ) {
        throw new Error("Nexus runtime is not installed.");
      }
      handle = new ConnectionHandle(
        session,
        this.lifecycle.engine,
        this.config.callTimeout ?? 5_000,
      );
      this.connections.set(session, handle);
    }
    return handle;
  }

  /** Owns the single bootstrap task and publishes the installed manager once ready. */
  private safeReadyManager(): Promise<Result<ConnectionManager<M>, Error>> {
    if (this.initialization) return this.initialization;
    this.initialization = Result.tryPromise({
      try: async (): Promise<Result<ConnectionManager<M>, Error>> => {
        // Reserve initialization before user-controlled configuration is read.
        await defer();
        this.lifecycle = { phase: "starting" };
        const config = snapshotConfig(this.config);
        const providers = [...this.serviceDeclarations.values()].map(
          (declaration) => ({
            ...declaration,
            options: declaration.options
              ? { ...declaration.options }
              : undefined,
          }),
        );
        const endpoint = this.endpointDeclaration
          ? {
              ...this.endpointDeclaration,
              options: snapshotEndpoint(this.endpointDeclaration.options),
            }
          : null;
        const built = await buildKernel<M>(
          config,
          providers,
          endpoint,
          (session) => this.connection(session),
        );
        if (built.isErr()) return err(built.error);
        const { engine, connectionManager: manager } = built.value;
        // Native listening may reenter RPC before startup completes.
        this.lifecycle = { phase: "listening", engine, manager };
        const initialized = await manager.safeInitialize();
        if (initialized.isErr()) return err(initialized.error);
        this.lifecycle = { phase: "ready", engine, manager };
        this.serviceDeclarations.clear();
        this.endpointDeclaration = null;
        this.readyChanel[1].safeEmit(manager).unwrapOr(undefined);
        this.readyChanel[1].clear();
        return ok(manager);
      },
      catch: (error) => error,
    }).then((attempt) =>
      attempt
        .andThen((result) => result)
        .mapError((error) =>
          error instanceof NexusConfigurationError
            ? error
            : new NexusConfigurationError(
                "Nexus bootstrap failed.",
                "E_NEXUS_BOOTSTRAP_FAILED",
                { cause: toSerializedError(error) },
              ),
        )
        .tapError((error) => {
          this.lifecycle = { phase: "failed", error };
          this.readyChanel[1].clear();
        }),
    );
    return this.initialization;
  }
}

/** Distinguishes object inputs from missing values and arrays at public configuration boundaries. */
const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Recognizes the descriptor overload without inspecting a service's implementation. */
const isProvider = <M extends AdapterModel>(
  value: unknown,
): value is ServiceProvider<object, M> =>
  isObject(value) && "token" in value && "service" in value;
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

import {
  ConnectionManager,
  ConnectionManagerError,
} from "@/connection/connection-manager";
import {
  NexusConfigurationError,
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
  NexusHandshakeError,
  NexusServiceError,
  NexusProtocolIncompatibleError,
  NexusUsageError,
} from "@/errors";
import { Engine } from "@/service/engine";
import type {
  AdapterModel,
  ConnectionTargetOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import { REF_WRAPPER_SYMBOL, type RefWrapper } from "@/types/ref-wrapper";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { Result } from "better-result";
import { toSerializedError } from "@/utils/error";
const { err, ok } = Result;
import { createEndpointDecorator } from "./decorators/endpoint";
import { createExposeDecorator } from "./decorators/expose";
import { NexusKernelBuilder } from "./kernel";
import { InstanceDecoratorRegistry, type DecoratorSnapshot } from "./registry";
import { TargetResolver } from "./target-resolver";
import { isPlainTarget, Token } from "./token";
import type {
  Allified,
  Asyncified,
  NexusInstance,
  RuntimeCreateTokenParam,
  Streamified,
  ValidCreateOptions,
} from "./types";
import {
  composeNexusConfig,
  type AuthorizationPolicy,
  type CreateMulticastOptions,
  type CreateOptions,
  type NexusConfig,
  type SelectMulticastOptions,
  type SelectOptions,
  type ServiceProvider,
} from "./types/config";

type Lifecycle =
  | "draft"
  | "scheduled"
  | "snapshotting"
  | "bootstrapping"
  | "ready"
  | "failed";
type Provider<M extends AdapterModel> = ServiceProvider<object, M>;

const defer = (work: () => Promise<void>): Promise<void> =>
  new Promise((resolve, reject) =>
    setTimeout(() => work().then(resolve, reject), 0),
  );

const unwrapResultOrThrow = <T>(result: Result<T, Error>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

const unwrapResultPromiseOrThrow = async <T>(
  result: Promise<Result<T, Error>>,
): Promise<T> => unwrapResultOrThrow(await result);

export class Nexus<
  M extends AdapterModel = AdapterModel,
> implements NexusInstance<M> {
  private readonly decoratorRegistry = new InstanceDecoratorRegistry();
  private config: NexusConfig<M> = {};
  private engine: Engine<M> | null = null;
  private connectionManager: ConnectionManager<M> | null = null;
  private initialization: Promise<void> | null = null;
  private failure: Error | null = null;
  private bootstrapDefaultTarget: ConnectionTargetOf<M> | undefined;
  private lifecycle: Lifecycle = "draft";

  public readonly Expose = createExposeDecorator(
    this.decoratorRegistry,
  ) as NexusInstance<M>["Expose"];
  public readonly Endpoint = createEndpointDecorator(
    this.decoratorRegistry,
  ) as NexusInstance<M>["Endpoint"];

  public configure<const T extends NexusConfig<M>>(
    config: T,
  ): NexusInstance<M> {
    return unwrapResultOrThrow(this.safeConfigure(config));
  }

  public safeConfigure<const T extends NexusConfig<M>>(
    config: T,
  ): Result<NexusInstance<M>, Error> {
    if (!isPlainObject(config))
      return err(
        new NexusUsageError(
          "Nexus: Invalid configure() input.",
          "E_USAGE_INVALID",
        ),
      );
    if (
      config.endpoint?.defaultTarget !== undefined &&
      !isPlainTarget(config.endpoint.defaultTarget)
    ) {
      return err(
        new NexusUsageError(
          "Nexus: endpoint.defaultTarget must be a plain object.",
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

  public provide<T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): this;
  public provide(registration: ServiceProvider<object, M>): this;
  public provide(registrations: readonly Provider<M>[]): this;
  public provide<T extends object>(
    input:
      | Token<T>
      | Token<T, M>
      | ServiceProvider<T, M>
      | readonly Provider<M>[],
    service?: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): this {
    const result = this.safeProvideNormalized(
      this.normalizeProviders(input, service, options),
    );
    return unwrapResultOrThrow(result);
  }

  public safeProvide<T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): Result<this, Error>;
  public safeProvide(
    registration: ServiceProvider<object, M>,
  ): Result<this, Error>;
  public safeProvide(
    registrations: readonly Provider<M>[],
  ): Result<this, Error>;
  public safeProvide<T extends object>(
    input:
      | Token<T>
      | Token<T, M>
      | ServiceProvider<T, M>
      | readonly Provider<M>[],
    service?: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): Result<this, Error> {
    if (this.lifecycle === "snapshotting" || this.lifecycle === "bootstrapping")
      return err(
        new NexusConfigurationError(
          "Nexus: provider registration window is closed during bootstrapping.",
          "E_NEXUS_BOOTSTRAPPING_LOCKED",
        ),
      );
    if (this.lifecycle === "failed") return err(this.failure!);
    const providers = this.normalizeProviders(input, service, options);
    return this.safeProvideNormalized(providers);
  }
  private normalizeProviders<T extends object>(
    input:
      | Token<T>
      | Token<T, M>
      | ServiceProvider<T, M>
      | readonly Provider<M>[],
    service?: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): readonly Provider<M>[] {
    if (isProviderList<M>(input)) return input;
    if (isProvider<M>(input)) return [input];
    return [{ token: input, service: service!, policy: options?.policy }];
  }
  private safeProvideNormalized(
    providers: readonly Provider<M>[],
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
      { providers: providers as Provider<M>[] },
    ]);
    return ok(this);
  }

  public ready(): Promise<void> {
    return unwrapResultPromiseOrThrow(this.safeReady());
  }
  public async safeReady(): Promise<Result<void, Error>> {
    return (await this.safeKernel()).map(() => undefined);
  }

  public create<
    T extends object,
    const O extends CreateOptions<M> = CreateOptions<M>,
  >(
    token: RuntimeCreateTokenParam<T, M>,
    options: O & ValidCreateOptions<O> = {} as O & ValidCreateOptions<O>,
  ): Promise<Asyncified<T>> {
    return unwrapResultPromiseOrThrow(this.safeCreateCore<T>(token, options));
  }
  public safeCreate<
    T extends object,
    const O extends CreateOptions<M> = CreateOptions<M>,
  >(
    token: RuntimeCreateTokenParam<T, M>,
    options: O & ValidCreateOptions<O> = {} as O & ValidCreateOptions<O>,
  ): Promise<Result<Asyncified<T>, Error>> {
    return this.safeCreateCore<T>(token, options);
  }
  private async safeCreateCore<T extends object>(
    token: unknown,
    options: unknown,
  ): Promise<Result<Asyncified<T>, Error>> {
    if (!isToken(token) || !isValidCreateOptions(options)) {
      return err(
        new NexusUsageError(
          "Nexus: create requires a Token and valid create options.",
          "E_USAGE_INVALID",
        ),
      );
    }
    const deadline = createDeadline(
      options.timeout,
      options.signal,
      "E_SERVICE_ACQUISITION_TIMEOUT",
    );
    if (deadline.isErr()) return err(deadline.error);
    try {
      const kernel = await raceDeadline(this.safeKernel(), deadline.value);
      if (kernel.isErr()) return err(kernel.error);
      const { engine, manager, defaultTarget } = kernel.value;
      const target = TargetResolver.resolveUnicastTarget(
        options.target,
        token.defaultTarget as ConnectionTargetOf<M> | undefined,
        defaultTarget,
        token.id,
      );
      if (target.isErr()) return err(target.error);
      const resolved = await raceDeadline(
        manager.safeResolveConnections({
          target: target.value,
          where: options.where,
        }),
        deadline.value,
      );
      if (resolved.isErr())
        return err(mapConnectionResolutionError(resolved.error));
      const select = () =>
        manager
          .getReadyTargetConnections(target.value, options.where)
          .find((connection) => provides(connection, token.id));
      let connection =
        resolved.value.find((item) => provides(item, token.id)) ?? select();
      while (!connection) {
        const accepted = manager.getReadyTargetConnections(
          target.value,
          options.where,
        );
        if (accepted.length === 0) {
          return err(
            new NexusServiceError(
              `Service "${token.id}" is unavailable.`,
              "E_SERVICE_UNAVAILABLE",
            ),
          );
        }
        await waitForAvailabilityAndRescan(manager, deadline.value, select);
        connection = select();
      }
      if (!connection.isReady()) {
        return err(
          new NexusServiceError(
            `Service "${token.id}" is unavailable.`,
            "E_SERVICE_UNAVAILABLE",
          ),
        );
      }
      return ok(
        engine.createServiceProxy<T>(token.id, {
          target: { connectionId: connection.connectionId },
          staleTarget: { where: options.where },
          strategy: "one",
          timeout: options.callTimeout ?? 5_000,
        }) as Asyncified<T>,
      );
    } catch (error) {
      return err(asError(error));
    } finally {
      deadline.value.cleanup();
    }
  }

  public createMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M> & { expects: "stream" },
  ): Promise<Streamified<T>>;
  public createMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M> & { expects?: "all" },
  ): Promise<Allified<T>>;
  public createMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M>,
  ): Promise<Allified<T> | Streamified<T>> {
    return unwrapResultPromiseOrThrow(
      this.safeCreateMulticastCore<T>(token, options),
    );
  }
  public safeCreateMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M> & { expects: "stream" },
  ): Promise<Result<Streamified<T>, Error>>;
  public safeCreateMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M> & { expects?: "all" },
  ): Promise<Result<Allified<T>, Error>>;
  public safeCreateMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M>,
  ): Promise<Result<Allified<T> | Streamified<T>, Error>> {
    return this.safeCreateMulticastCore<T>(token, options);
  }
  private async safeCreateMulticastCore<T extends object>(
    token: unknown,
    options: unknown,
  ): Promise<Result<Allified<T> | Streamified<T>, Error>> {
    if (!isToken(token) || !isValidMulticastOptions(options)) {
      return err(
        new NexusUsageError(
          "Nexus: multicast requires a Token and valid multicast options.",
          "E_USAGE_INVALID",
        ),
      );
    }
    const deadline = createDeadline(
      options.timeout,
      options.signal,
      "E_SERVICE_ACQUISITION_TIMEOUT",
    );
    if (deadline.isErr()) return err(deadline.error);
    try {
      const kernel = await raceDeadline(this.safeKernel(), deadline.value);
      if (kernel.isErr()) return err(kernel.error);
      const { engine, manager } = kernel.value;
      const initial = await Promise.all(
        options.targets.map(async (target) => {
          const result = await raceDeadline(
            manager.safeResolveConnections({ target, where: options.where }),
            deadline.value,
          );
          if (result.isErr()) throw mapConnectionResolutionError(result.error);
          if (result.value.length === 0)
            throw new NexusServiceError(
              `Service target for "${token.id}" is unavailable.`,
              "E_SERVICE_UNAVAILABLE",
            );
          return result.value;
        }),
      );
      const scan = () =>
        options.targets.map((target) =>
          manager.getReadyTargetConnections(target, options.where),
        );
      let accepted = initial;
      while (true) {
        if (accepted.some((connections) => connections.length === 0)) {
          return err(
            new NexusServiceError(
              `Service target for "${token.id}" is unavailable.`,
              "E_SERVICE_UNAVAILABLE",
            ),
          );
        }
        const providers = accepted.map((connections) =>
          connections.find(
            (connection) =>
              provides(connection, token.id) && connection.isReady(),
          ),
        );
        if (providers.every((connection) => connection)) {
          // Re-read immediately before binding: a ready provider can disappear
          // between the availability scan and proxy construction.
          const final = scan();
          if (final.some((connections) => connections.length === 0)) {
            return err(
              new NexusServiceError(
                `Service target for "${token.id}" is unavailable.`,
                "E_SERVICE_UNAVAILABLE",
              ),
            );
          }
          const finalProviders = final.map((connections) =>
            connections.find(
              (connection) =>
                provides(connection, token.id) && connection.isReady(),
            ),
          );
          if (finalProviders.every((connection) => connection)) {
            const connectionIds = Array.from(
              new Set(
                finalProviders.map((connection) => connection!.connectionId),
              ),
            );
            return ok(
              engine.createServiceProxy<T>(token.id, {
                target: { connectionIds },
                strategy: options.expects ?? "all",
                timeout: options.callTimeout ?? 5_000,
              }) as Allified<T> | Streamified<T>,
            );
          }
          accepted = final;
        }
        await waitForAvailabilityAndRescan(manager, deadline.value, () =>
          scan().every((connections) =>
            connections.some(
              (connection) =>
                provides(connection, token.id) && connection.isReady(),
            ),
          ),
        );
        accepted = scan();
      }
    } catch (error) {
      return err(asError(error));
    } finally {
      deadline.value.cleanup();
    }
  }

  public select<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: SelectOptions<M> = {},
  ): Promise<Asyncified<T>> {
    return unwrapResultPromiseOrThrow(this.safeSelectCore<T>(token, options));
  }
  public safeSelect<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: SelectOptions<M> = {},
  ): Promise<Result<Asyncified<T>, Error>> {
    return this.safeSelectCore<T>(token, options);
  }
  private async safeSelectCore<T extends object>(
    token: unknown,
    options: unknown,
  ): Promise<Result<Asyncified<T>, Error>> {
    if (!isToken(token) || !isValidSelectOptions(options)) {
      return err(
        new NexusUsageError(
          "Nexus: select requires a Token and valid select options.",
          "E_USAGE_INVALID",
        ),
      );
    }
    try {
      const kernel = await this.safeKernel();
      if (kernel.isErr()) return err(kernel.error);
      const scan = () =>
        kernel.value.manager.getReadyProviderConnections(
          token.id,
          options.where,
        );
      let candidates = scan();
      if (candidates.length === 0 && options.wait) {
        const deadline = createDeadline(
          options.wait.timeout,
          options.wait.signal,
          "E_SERVICE_WAIT_TIMEOUT",
        );
        if (deadline.isErr()) return err(deadline.error);
        try {
          while (candidates.length === 0) {
            await waitForAvailabilityAndRescan(
              kernel.value.manager,
              deadline.value,
              () => scan().length > 0,
            );
            candidates = scan();
          }
        } catch (error) {
          return err(asError(error));
        } finally {
          deadline.value.cleanup();
        }
      }
      if (candidates.length === 0)
        return err(
          new NexusServiceError(
            `No provider for "${token.id}" is available.`,
            "E_SERVICE_NO_MATCH",
          ),
        );
      if (candidates.length > 1)
        return err(
          new NexusServiceError(
            `Multiple providers for "${token.id}" are available.`,
            "E_SERVICE_AMBIGUOUS",
          ),
        );
      return ok(
        kernel.value.engine.createServiceProxy<T>(token.id, {
          target: { connectionId: candidates[0].connectionId },
          staleTarget: { where: options.where },
          strategy: "one",
          timeout: options.callTimeout ?? 5_000,
        }) as Asyncified<T>,
      );
    } catch (error) {
      return err(asError(error));
    }
  }

  public selectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: SelectMulticastOptions<M> & { expects: "stream" },
  ): Promise<Streamified<T>>;
  public selectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: SelectMulticastOptions<M> & { expects?: "all" },
  ): Promise<Allified<T>>;
  public selectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: SelectMulticastOptions<M> = {},
  ): Promise<Allified<T> | Streamified<T>> {
    return unwrapResultPromiseOrThrow(
      this.safeSelectMulticastCore<T>(token, options),
    );
  }
  public safeSelectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: SelectMulticastOptions<M> & { expects: "stream" },
  ): Promise<Result<Streamified<T>, Error>>;
  public safeSelectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: SelectMulticastOptions<M> & { expects?: "all" },
  ): Promise<Result<Allified<T>, Error>>;
  public safeSelectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: SelectMulticastOptions<M> = {},
  ): Promise<Result<Allified<T> | Streamified<T>, Error>> {
    return this.safeSelectMulticastCore<T>(token, options);
  }
  private async safeSelectMulticastCore<T extends object>(
    token: unknown,
    options: unknown,
  ): Promise<Result<Allified<T> | Streamified<T>, Error>> {
    if (!isToken(token) || !isValidSelectMulticastOptions(options)) {
      return err(
        new NexusUsageError(
          "Nexus: selectMulticast requires a Token and valid options.",
          "E_USAGE_INVALID",
        ),
      );
    }
    try {
      const kernel = await this.safeKernel();
      if (kernel.isErr()) return err(kernel.error);
      const { engine, manager } = kernel.value;
      return ok(
        engine.createServiceProxy<T>(token.id, {
          target: {
            connectionIds: manager
              .getReadyProviderConnections(token.id, options.where)
              .map((connection) => connection.connectionId),
          },
          strategy: options.expects ?? "all",
          timeout: options.callTimeout ?? 5_000,
        }) as Allified<T> | Streamified<T>,
      );
    } catch (error) {
      return err(asError(error));
    }
  }

  public updateIdentity(updates: Partial<ContextMetaOf<M>>): Promise<void> {
    return unwrapResultPromiseOrThrow(this.safeUpdateIdentity(updates));
  }
  public async safeUpdateIdentity(
    updates: Partial<ContextMetaOf<M>>,
  ): Promise<Result<void, Error>> {
    if (!isPlainObject(updates))
      return err(
        new NexusUsageError(
          "Nexus: Invalid updateIdentity() input.",
          "E_USAGE_INVALID",
        ),
      );
    return (await this.safeKernel()).andThen(({ manager }) => {
      const result = manager.safeUpdateLocalIdentity(updates);
      return result.isErr() ? err(result.error) : ok(undefined);
    });
  }
  public ref<T extends object>(target: T): RefWrapper<T> {
    return unwrapResultOrThrow(this.safeRef(target));
  }
  public safeRef<T extends object>(target: T): Result<RefWrapper<T>, Error> {
    return !target || typeof target !== "object"
      ? err(new NexusUsageError("Nexus.ref() can only be used with objects."))
      : ok({ [REF_WRAPPER_SYMBOL]: true, target });
  }
  public release(proxy: object): void {
    unwrapResultOrThrow(this.safeRelease(proxy));
  }
  public safeRelease(proxy: object): Result<void, Error> {
    if ((typeof proxy === "object" && proxy) || typeof proxy === "function") {
      const release = (proxy as { [RELEASE_PROXY_SYMBOL]?: unknown })[
        RELEASE_PROXY_SYMBOL
      ];
      if (typeof release === "function") release();
    }
    return ok(undefined);
  }

  private scheduleInitialization(): void {
    if (this.initialization) return;
    this.lifecycle = "scheduled";
    this.initialization = defer(async () => {
      this.lifecycle = "snapshotting";
      const snapshot = this.snapshot();
      this.bootstrapDefaultTarget = clone(
        snapshot.decorators.endpoint?.options.defaultTarget ??
          snapshot.config.endpoint?.defaultTarget,
      );
      const kernelResult = await NexusKernelBuilder.create(
        snapshot.config,
        snapshot.decorators.providers,
        snapshot.decorators.endpoint as never,
      ).build();
      const kernel = unwrapResultOrThrow(
        await kernelResult.andThenAsync(async (value) =>
          (await value.connectionManager.safeInitialize()).map(() => value),
        ),
      );
      this.lifecycle = "bootstrapping";
      this.engine = kernel.engine;
      this.connectionManager = kernel.connectionManager;
      this.lifecycle = "ready";
    }).catch((error) => {
      this.failure =
        error instanceof NexusConfigurationError
          ? error
          : new NexusConfigurationError(
              "Nexus bootstrap failed.",
              "E_NEXUS_BOOTSTRAP_FAILED",
              { cause: error as never },
            );
      this.lifecycle = "failed";
      throw this.failure;
    });
  }

  private snapshot(): {
    config: NexusConfig<M>;
    decorators: DecoratorSnapshot<M>;
  } {
    const decorators =
      this.decoratorRegistry.snapshot() as DecoratorSnapshot<M>;
    return {
      config: cloneConfig(this.config),
      decorators: {
        providers: new Map(decorators.providers),
        endpoint: decorators.endpoint
          ? {
              ...decorators.endpoint,
              options: {
                ...decorators.endpoint.options,
                meta: clone(decorators.endpoint.options.meta),
                defaultTarget: clone(decorators.endpoint.options.defaultTarget),
              },
            }
          : null,
      },
    };
  }
  private async safeKernel(): Promise<
    Result<
      {
        engine: Engine<M>;
        manager: ConnectionManager<M>;
        defaultTarget: ConnectionTargetOf<M> | undefined;
      },
      Error
    >
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
        ? ok({
            engine: this.engine,
            manager: this.connectionManager,
            defaultTarget: this.bootstrapDefaultTarget,
          })
        : err(
            this.failure ??
              new NexusConfigurationError("Nexus initialization failed."),
          ),
    );
  }
}

const isPlainObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isProvider = <M extends AdapterModel>(
  value: unknown,
): value is ServiceProvider<object, M> =>
  isPlainObject(value) && "token" in value && "service" in value;
const isProviderList = <M extends AdapterModel>(
  value: unknown,
): value is readonly Provider<M>[] => Array.isArray(value);
const isStructuralConfig = <M extends AdapterModel>(
  config: NexusConfig<M>,
): boolean =>
  Object.hasOwn(config, "providers") ||
  Object.hasOwn(config, "policy") ||
  Object.hasOwn(config, "endpoint");
const clone = <T>(value: T): T =>
  Array.isArray(value)
    ? (value.map(clone) as T)
    : isPlainObject(value)
      ? (Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            typeof item === "function" ? item : clone(item),
          ]),
        ) as T)
      : value;
const cloneConfig = <M extends AdapterModel>(
  config: NexusConfig<M>,
): NexusConfig<M> => ({
  ...config,
  endpoint: config.endpoint
    ? {
        ...config.endpoint,
        meta: config.endpoint.meta ? clone(config.endpoint.meta) : undefined,
        defaultTarget: clone(config.endpoint.defaultTarget),
      }
    : undefined,
  providers: config.providers?.map((provider) => ({ ...provider })),
});
const isToken = (value: unknown): value is Token<object> =>
  value instanceof Token;
const isOptionsObject = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const isTargetObject = isPlainTarget;
const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));
const isValidTimeout = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === "number" && Number.isFinite(value) && value >= 0);
const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
const isValidCreateOptions = (
  options: unknown,
): options is CreateOptions<any> =>
  isOptionsObject(options) &&
  hasOnlyKeys(options, [
    "target",
    "where",
    "timeout",
    "signal",
    "callTimeout",
  ]) &&
  (options.target === undefined || isTargetObject(options.target)) &&
  (options.where === undefined || typeof options.where === "function") &&
  isValidTimeout(options.timeout) &&
  isValidTimeout(options.callTimeout) &&
  (options.signal === undefined || isAbortSignal(options.signal));
const isValidMulticastOptions = (
  options: unknown,
): options is CreateMulticastOptions<any> =>
  isOptionsObject(options) &&
  hasOnlyKeys(options, [
    "targets",
    "where",
    "expects",
    "timeout",
    "signal",
    "callTimeout",
  ]) &&
  Array.isArray(options.targets) &&
  options.targets.length > 0 &&
  options.targets.every(isTargetObject) &&
  (options.where === undefined || typeof options.where === "function") &&
  isValidTimeout(options.timeout) &&
  isValidTimeout(options.callTimeout) &&
  (options.signal === undefined || isAbortSignal(options.signal)) &&
  (options.expects === undefined ||
    options.expects === "all" ||
    options.expects === "stream");
const isValidSelectOptions = (
  options: unknown,
): options is SelectOptions<any> =>
  isOptionsObject(options) &&
  hasOnlyKeys(options, ["where", "wait", "callTimeout"]) &&
  (options.where === undefined || typeof options.where === "function") &&
  isValidTimeout(options.callTimeout) &&
  (options.wait === undefined ||
    (isOptionsObject(options.wait) &&
      hasOnlyKeys(options.wait, ["timeout", "signal"]) &&
      isValidTimeout(options.wait.timeout) &&
      (options.wait.signal === undefined ||
        isAbortSignal(options.wait.signal))));
const isValidSelectMulticastOptions = (
  options: unknown,
): options is SelectMulticastOptions<any> =>
  isOptionsObject(options) &&
  hasOnlyKeys(options, ["where", "expects", "callTimeout"]) &&
  (options.where === undefined || typeof options.where === "function") &&
  isValidTimeout(options.callTimeout) &&
  (options.expects === undefined ||
    options.expects === "all" ||
    options.expects === "stream");

type Deadline = { promise: Promise<never>; cleanup: () => void };
const createDeadline = (
  timeout: number | undefined,
  signal: AbortSignal | undefined,
  timeoutCode: "E_SERVICE_ACQUISITION_TIMEOUT" | "E_SERVICE_WAIT_TIMEOUT",
): Result<Deadline, Error> => {
  if (
    !isValidTimeout(timeout) ||
    (signal !== undefined && !isAbortSignal(signal))
  ) {
    return err(
      new NexusUsageError(
        "Nexus: timeout and signal must be valid.",
        "E_USAGE_INVALID",
      ),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reject!: (error: Error) => void;
  const onAbort = () =>
    reject(
      new NexusServiceError("Service acquisition was aborted.", "E_ABORTED"),
    );
  const promise = new Promise<never>((_, rejectPromise) => {
    reject = rejectPromise;
    timer = setTimeout(
      () =>
        reject(
          new NexusServiceError("Service acquisition timed out.", timeoutCode),
        ),
      timeout ?? 30_000,
    );
  });
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return ok({
    promise,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  });
};
const raceDeadline = <T>(promise: Promise<T>, deadline: Deadline): Promise<T> =>
  Promise.race([promise, deadline.promise]);
const waitForAvailabilityAndRescan = <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  deadline: Deadline,
  hasMatch: () => unknown,
): Promise<void> => {
  let unsubscribe: (() => void) | undefined;
  const event = new Promise<void>((resolve) => {
    unsubscribe = manager.subscribeAvailabilityChanged(resolve);
    if (hasMatch()) resolve();
  });
  return raceDeadline(event, deadline).finally(() => unsubscribe?.());
};
const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));
const provides = (
  connection: { remoteProviders?: ReadonlySet<string> },
  tokenId: string,
): boolean => connection.remoteProviders?.has(tokenId) ?? true;

const mapConnectionResolutionError = (error: ConnectionManagerError): Error => {
  const cause = error.cause ? toSerializedError(error.cause) : undefined;
  const endpointConnect = findEndpointConnectError(error);
  if (endpointConnect) {
    return new NexusEndpointConnectError(error.message, {
      context: error.context,
      cause: toSerializedError(endpointConnect),
    });
  }
  if (error.code === "E_CONNECTION_CONSTRAINT_FAILED") {
    return new NexusServiceError(error.message, "E_TARGET_CONSTRAINT_FAILED", {
      context: error.context,
      cause,
    });
  }

  if (error.code === "E_PROTOCOL_INCOMPATIBLE") {
    return new NexusProtocolIncompatibleError(
      error.message,
      error.context,
      cause,
    );
  }

  if (error.code === "E_HANDSHAKE_FAILED") {
    return new NexusHandshakeError(
      error.message,
      "E_HANDSHAKE_FAILED",
      error.context,
      { cause },
    );
  }

  if (error.code === "E_AUTH_CONNECT_DENIED") {
    return new NexusHandshakeError(
      error.message,
      "E_HANDSHAKE_REJECTED",
      error.context,
      { cause },
    );
  }

  if (error.code === "E_ENDPOINT_CAPABILITY_MISMATCH") {
    return new NexusEndpointCapabilityError(error.message, {
      context: error.context,
      cause,
    });
  }

  if (error.code === "E_USAGE_INVALID") {
    return new NexusUsageError(error.message, "E_USAGE_INVALID", {
      cause,
    });
  }

  return new NexusServiceError(error.message, "E_SERVICE_UNAVAILABLE", {
    context: error.context,
    cause,
  });
};

const findEndpointConnectError = (
  value: unknown,
): NexusEndpointConnectError | null => {
  let current = value;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof NexusEndpointConnectError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
};

export const nexus = new Nexus();

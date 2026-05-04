import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import { merge } from "es-toolkit";
import {
  NexusConfig,
  ServiceRegistration,
  AuthorizationPolicy,
  CreateOptions,
  TargetMatcher,
  CreateMulticastOptions,
  TargetCriteria,
} from "./types/config";
import type { Token } from "./token";
import { Engine } from "@/service/engine";
import { ConnectionManager } from "@/connection/connection-manager";
import type {
  NexusInstance,
  MatcherUtils,
  Asyncified,
  Allified,
  Streamified,
} from "./types";
import type { CreateProxyOptions } from "@/service/proxy-factory";
import { InstanceDecoratorRegistry, type DecoratorSnapshot } from "./registry";
import { createExposeDecorator } from "./decorators/expose";
import { createEndpointDecorator } from "./decorators/endpoint";
import { REF_WRAPPER_SYMBOL, RefWrapper } from "@/types/ref-wrapper";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { NexusKernelBuilder } from "./kernel";
import {
  NexusConfigurationError,
  NexusTargetingError,
  NexusUsageError,
} from "@/errors";
import {
  ResultAsync,
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
} from "neverthrow";
import { args, fn } from "@/utils/fn";
import { z } from "zod";
import { TargetResolver } from "./target-resolver";
import { MatcherCombinators } from "./matcher-utils";

// Type utilities for extracting matcher and descriptor names from config objects
type GetMatchers<T> = T extends { matchers: infer M }
  ? keyof M & string
  : never;
type GetDescriptors<T> = T extends { descriptors: infer D }
  ? keyof D & string
  : never;

const PlainObjectSchema = z.custom<object>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
);

const ServiceImplementationSchema = z.custom<object>(
  (value) =>
    (typeof value === "object" && value !== null && !Array.isArray(value)) ||
    typeof value === "function",
);

const validateConfigureInput = fn(PlainObjectSchema, (input) => input);

const validateCreateInput = fn(
  args([
    ["token", z.object({ id: z.string() })],
    [
      "options",
      z
        .object({
          target: PlainObjectSchema.nullish(),
          expects: z.enum(["one", "first"]).optional(),
          timeout: z.number().optional(),
        })
        .optional(),
    ],
  ] as const),
  (token, options) => ({ token, options }),
);

const validateCreateMulticastInput = fn(
  args([
    ["token", z.object({ id: z.string() })],
    [
      "options",
      z.object({
        target: PlainObjectSchema,
        expects: z.enum(["all", "stream"]).optional(),
        timeout: z.number().optional(),
      }),
    ],
  ] as const),
  (token, options) => ({ token, options }),
);

const validateUpdateIdentityInput = fn(PlainObjectSchema, (input) => input);

const ServiceRegistrationSchema = z.object({
  token: z.object({ id: z.string().min(1) }),
  implementation: ServiceImplementationSchema,
  policy: z.custom<AuthorizationPolicy<any, any>>().optional(),
});

type ProviderRegistration<
  U extends UserMetadata,
  P extends PlatformMetadata,
> = {
  readonly token: Token<object>;
  readonly implementation: object;
  readonly policy?: AuthorizationPolicy<U, P>;
};

const unwrapResultOrThrow = <T>(result: Result<T, Error>): T =>
  result.match(
    (value) => value,
    (error) => {
      throw error;
    },
  );

const unwrapResultAsyncOrThrow = <T>(
  result: ResultAsync<T, Error>,
): Promise<T> =>
  result.match(
    (value) => value,
    (error) => {
      throw error;
    },
  );

const deferToNextTick = (work: () => Promise<void>): Promise<void> =>
  new Promise((resolve, reject) => {
    setTimeout(() => {
      work().then(resolve, reject);
    }, 0);
  });

/**
 * Core instance class of the Nexus framework.
 * It serves as the entry point for all L4 APIs and manages the lifecycle of internal L1-L3 components.
 *
 * @template U Base user metadata type
 * @template P Base platform metadata type
 * @template RegisteredMatchers Union type of registered named matchers
 * @template RegisteredDescriptors Union type of registered named descriptors
 */
export class Nexus<
  U extends UserMetadata = any,
  P extends PlatformMetadata = any,
  RegisteredMatchers extends string = never,
  RegisteredDescriptors extends string = never,
> implements NexusInstance<U, P, RegisteredMatchers, RegisteredDescriptors> {
  // L3 engine instance, lazily initialized
  private engine: Engine<U, P> | null = null;
  // L2 connection manager instance, lazily initialized
  private connectionManager: ConnectionManager<U, P> | null = null;
  // Stores the merged configuration
  private config: NexusConfig<U, P, string, string> = {};
  private readonly decoratorRegistry = new InstanceDecoratorRegistry();
  // Promise barrier for lazy initialization
  private initializationPromise: Promise<void> | null = null;
  private terminalBootstrapError: Error | null = null;
  private lifecycleState:
    | "draft"
    | "scheduled"
    | "snapshotting"
    | "bootstrapping"
    | "ready"
    | "failed"
    | "disposed" = "draft";
  // Added: state lock to ensure initialization is scheduled only once
  private isInitScheduled = false;
  private readonly liveProviderTokenIds = new Set<string>();
  private bootstrappedConnectToFallback:
    | readonly TargetCriteria<U, string, string>[]
    | undefined;

  // Named entity cache for performance optimization
  private readonly namedMatchers = new Map<string, (identity: U) => boolean>();
  private readonly namedDescriptors = new Map<string, Partial<U>>();

  public readonly matchers: MatcherUtils<U, RegisteredMatchers>;
  public readonly Expose = createExposeDecorator(
    this.decoratorRegistry,
  ) as NexusInstance<U, P, RegisteredMatchers, RegisteredDescriptors>["Expose"];
  public readonly Endpoint = createEndpointDecorator(
    this.decoratorRegistry,
  ) as NexusInstance<
    U,
    P,
    RegisteredMatchers,
    RegisteredDescriptors
  >["Endpoint"];

  constructor() {
    const resolveNamedMatcher = (name: string) => this.namedMatchers.get(name);

    this.matchers = {
      and: (...matchers: TargetMatcher<U, RegisteredMatchers>[]) => {
        return MatcherCombinators.and(resolveNamedMatcher, ...matchers);
      },
      or: (...matchers: TargetMatcher<U, RegisteredMatchers>[]) => {
        return MatcherCombinators.or(resolveNamedMatcher, ...matchers);
      },
      not: (matcher: TargetMatcher<U, RegisteredMatchers>) => {
        return MatcherCombinators.not(resolveNamedMatcher, matcher);
      },
    };
  }

  public safeConfigure<const T extends NexusConfig<U, P>>(
    config: T,
  ): Result<
    NexusInstance<
      U,
      P,
      RegisteredMatchers | GetMatchers<T>,
      RegisteredDescriptors | GetDescriptors<T>
    >,
    Error
  > {
    const validatedConfig = validateConfigureInput(config);
    if (validatedConfig.isErr()) {
      return err(
        new NexusUsageError(
          "Nexus: Invalid configure() input.",
          "E_USAGE_INVALID",
          {
            cause: validatedConfig.error,
          },
        ),
      );
    }

    const lifecycleError = this.safeAssertCanConfigure(config);
    if (lifecycleError.isErr()) {
      return err(lifecycleError.error);
    }

    const { services, ...configWithoutServices } = config;
    this.config = merge(this.config, configWithoutServices);
    if (services) {
      this.config.services = [...(this.config.services ?? []), ...services];
    }

    if (config.matchers) {
      for (const name of Object.keys(config.matchers)) {
        this.namedMatchers.set(name, config.matchers[name]);
      }
    }
    if (config.descriptors) {
      for (const name of Object.keys(config.descriptors)) {
        this.namedDescriptors.set(name, config.descriptors[name]);
      }
    }

    this.scheduleInit();
    return ok(
      this as NexusInstance<
        U,
        P,
        RegisteredMatchers | GetMatchers<T>,
        RegisteredDescriptors | GetDescriptors<T>
      >,
    );
  }

  public provide<T extends object>(
    token: Token<T>,
    implementation: T,
    options?: { policy?: AuthorizationPolicy<U, P> },
  ): this;
  public provide<T extends object>(
    registration: ServiceRegistration<T, U, P>,
  ): this;
  public provide(
    registrations: readonly ServiceRegistration<object, U, P>[],
  ): this;
  public provide<T extends object>(
    tokenOrRegistration:
      | Token<T>
      | ServiceRegistration<T, U, P>
      | readonly ServiceRegistration<object, U, P>[],
    implementation?: T,
    options?: { policy?: AuthorizationPolicy<U, P> },
  ): this {
    return unwrapResultOrThrow(
      this.safeProvide(
        tokenOrRegistration as Token<T>,
        implementation as T,
        options,
      ),
    );
  }

  public safeProvide<T extends object>(
    token: Token<T>,
    implementation: T,
    options?: { policy?: AuthorizationPolicy<U, P> },
  ): Result<this, Error>;
  public safeProvide<T extends object>(
    registration: ServiceRegistration<T, U, P>,
  ): Result<this, Error>;
  public safeProvide(
    registrations: readonly ServiceRegistration<object, U, P>[],
  ): Result<this, Error>;
  public safeProvide<T extends object>(
    tokenOrRegistration:
      | Token<T>
      | ServiceRegistration<T, U, P>
      | readonly ServiceRegistration<object, U, P>[],
    implementation?: T,
    options?: { policy?: AuthorizationPolicy<U, P> },
  ): Result<this, Error> {
    const normalized = this.normalizeProviderInput(
      tokenOrRegistration,
      implementation,
      options,
    );
    if (normalized.isErr()) {
      return err(normalized.error);
    }

    const lifecycleError = this.safeAssertCanProvide();
    if (lifecycleError.isErr()) {
      return err(lifecycleError.error);
    }

    const duplicateError = this.validateProviderDuplicates(
      normalized.value,
      Array.isArray(tokenOrRegistration),
    );
    if (duplicateError.isErr()) {
      return err(duplicateError.error);
    }

    if (this.lifecycleState === "ready" && this.engine) {
      const liveResult = this.engine.safeProvideServicesBatch(
        Object.fromEntries(
          normalized.value.map((registration) => [
            registration.token.id,
            {
              implementation: registration.implementation,
              policy: registration.policy,
            },
          ]),
        ),
      );
      if (liveResult.isErr()) {
        return err(liveResult.error);
      }
      for (const registration of normalized.value) {
        this.liveProviderTokenIds.add(registration.token.id);
      }
      return ok(this);
    }

    this.config.services = [
      ...(this.config.services ?? []),
      ...normalized.value.map((registration) => ({
        token: registration.token,
        implementation: registration.implementation,
        policy: registration.policy,
      })),
    ];

    return ok(this);
  }

  public ready(): Promise<void> {
    return unwrapResultAsyncOrThrow(this.safeReady());
  }

  public safeReady(): ResultAsync<void, Error> {
    return this.safeEnsureKernelReady().map(() => undefined);
  }

  private safeAssertCanProvide(): Result<void, Error> {
    if (
      this.lifecycleState === "snapshotting" ||
      this.lifecycleState === "bootstrapping"
    ) {
      return err(
        new NexusConfigurationError(
          "Nexus: provider registration window is closed during bootstrapping.",
          "E_NEXUS_BOOTSTRAPPING_LOCKED",
        ),
      );
    }
    if (this.lifecycleState === "failed") {
      return err(
        new NexusConfigurationError(
          "Nexus: cannot register providers after bootstrap failure.",
          "E_NEXUS_BOOTSTRAP_FAILED",
        ),
      );
    }
    if (this.lifecycleState === "disposed") {
      return err(
        new NexusConfigurationError(
          "Nexus: cannot register providers after disposal.",
          "E_NEXUS_DISPOSED",
        ),
      );
    }
    return ok(undefined);
  }

  private safeAssertCanConfigure(
    config: NexusConfig<U, P, string, string>,
  ): Result<void, Error> {
    if (this.lifecycleState === "ready" && this.isStructuralConfigure(config)) {
      return err(
        new NexusConfigurationError(
          "Nexus: structural configure() cannot be called after ready. Use updateIdentity() for endpoint meta changes.",
          "E_NEXUS_ALREADY_READY",
        ),
      );
    }
    if (
      this.lifecycleState === "snapshotting" ||
      this.lifecycleState === "bootstrapping"
    ) {
      return err(
        new NexusConfigurationError(
          "Nexus: configure() cannot be called during bootstrapping.",
          "E_NEXUS_BOOTSTRAPPING_LOCKED",
        ),
      );
    }
    if (this.lifecycleState === "failed") {
      return err(
        new NexusConfigurationError(
          "Nexus: cannot configure after bootstrap failure.",
          "E_NEXUS_BOOTSTRAP_FAILED",
        ),
      );
    }
    if (this.lifecycleState === "disposed") {
      return err(
        new NexusConfigurationError(
          "Nexus: cannot configure after disposal.",
          "E_NEXUS_DISPOSED",
        ),
      );
    }
    return ok(undefined);
  }

  private isStructuralConfigure(
    config: NexusConfig<U, P, string, string>,
  ): boolean {
    return Boolean(
      config.services ||
      config.policy ||
      config.matchers ||
      config.descriptors ||
      config.endpoint?.meta ||
      config.endpoint?.implementation ||
      config.endpoint?.connectTo ||
      config.implementation,
    );
  }

  private normalizeProviderInput<T extends object>(
    tokenOrRegistration:
      | Token<T>
      | ServiceRegistration<T, U, P>
      | readonly ServiceRegistration<object, U, P>[],
    implementation?: T,
    options?: { policy?: AuthorizationPolicy<U, P> },
  ): Result<ProviderRegistration<U, P>[], Error> {
    if (
      !Array.isArray(tokenOrRegistration) &&
      (tokenOrRegistration === null ||
        (typeof tokenOrRegistration !== "object" &&
          typeof tokenOrRegistration !== "function"))
    ) {
      return err(
        this.createProviderBatchError([
          new NexusUsageError(
            "Nexus: Invalid provider registration.",
            "E_USAGE_INVALID",
          ),
        ]),
      );
    }

    const registrations = Array.isArray(tokenOrRegistration)
      ? tokenOrRegistration
      : typeof tokenOrRegistration === "object" &&
          tokenOrRegistration !== null &&
          "token" in tokenOrRegistration
        ? [tokenOrRegistration]
        : [
            {
              token: tokenOrRegistration,
              implementation,
              policy: options?.policy,
            },
          ];

    const normalized: ProviderRegistration<U, P>[] = [];
    const validationErrors: Error[] = [];
    for (const registration of registrations) {
      const validation = ServiceRegistrationSchema.safeParse(registration);
      if (!validation.success) {
        validationErrors.push(
          new NexusUsageError(
            "Nexus: Invalid provider registration.",
            "E_USAGE_INVALID",
            {
              cause: validation.error,
            },
          ),
        );
        continue;
      }
      normalized.push({
        token: registration.token as Token<object>,
        implementation: registration.implementation as object,
        policy: registration.policy,
      });
    }

    const duplicateResult = this.validateProviderDuplicates(
      normalized,
      Array.isArray(tokenOrRegistration),
    );
    const errors = [
      ...validationErrors,
      ...(duplicateResult.isErr()
        ? this.expandProviderBatchError(duplicateResult.error)
        : []),
    ];

    if (errors.length > 0) {
      return err(this.createProviderBatchError(errors));
    }
    return ok(normalized);
  }

  private validateProviderDuplicates(
    registrations: readonly ProviderRegistration<U, P>[],
    forceBatchError = false,
    existingIds = new Set(
      (this.config.services ?? []).map((entry) => entry.token.id),
    ),
  ): Result<void, Error> {
    for (const tokenId of this.liveProviderTokenIds) {
      existingIds.add(tokenId);
    }
    const seenIds = new Set<string>();
    const errors: Error[] = [];
    for (const registration of registrations) {
      const tokenId = registration.token.id;
      if (existingIds.has(tokenId) || seenIds.has(tokenId)) {
        errors.push(
          new NexusConfigurationError(
            `Nexus: Provider token id "${tokenId}" is already registered.`,
            "E_PROVIDER_DUPLICATE_TOKEN",
            { tokenId },
          ),
        );
      }
      seenIds.add(tokenId);
    }
    if (errors.length > 0) {
      return err(
        forceBatchError || errors.length > 1
          ? this.createProviderBatchError(errors)
          : errors[0],
      );
    }
    return ok(undefined);
  }

  private createProviderBatchError(
    errors: readonly Error[],
  ): NexusConfigurationError {
    return new NexusConfigurationError(
      "Nexus: provider batch registration failed validation.",
      "E_PROVIDER_BATCH_INVALID",
      {
        errors: errors.map((error) => ({
          message: error.message,
          code:
            "code" in error ? (error as { code: string }).code : "E_UNKNOWN",
          context:
            "context" in error
              ? (error as { context?: unknown }).context
              : undefined,
        })),
      },
    );
  }

  private expandProviderBatchError(error: Error): Error[] {
    if (
      "code" in error &&
      (error as { code: string }).code === "E_PROVIDER_BATCH_INVALID" &&
      "context" in error &&
      Array.isArray(
        (error as { context?: { errors?: unknown[] } }).context?.errors,
      )
    ) {
      return (
        error as {
          context: {
            errors: {
              message: string;
              code: string;
              context?: Record<string, unknown>;
            }[];
          };
        }
      ).context.errors.map(
        (entry) =>
          new NexusConfigurationError(
            entry.message,
            entry.code as any,
            entry.context,
          ),
      );
    }
    return [error];
  }

  /**
   * Unified configuration entry point.
   * This method modifies the nexus instance's configuration in place and uses TypeScript's
   * 实现类型的增强与合并，返回一个类型被“增强”了的 nexus 实例。
   *
   * @param config Configuration object
   * @returns Type-evolved Nexus instance
   */
  public configure<const T extends NexusConfig<U, P>>(
    config: T,
  ): NexusInstance<
    U,
    P,
    RegisteredMatchers | GetMatchers<T>,
    RegisteredDescriptors | GetDescriptors<T>
  > {
    return unwrapResultOrThrow(this.safeConfigure(config));
  }

  /**
   * Schedule kernel initialization.
   * Initialization is deferred to the next event loop to ensure all synchronous code
   * from all modules (including all configure calls and decorators) has been executed.
   */
  private scheduleInit(): void {
    if (this.isInitScheduled) {
      return;
    }
    this.isInitScheduled = true;
    this.lifecycleState = "scheduled";
    // _initialize() is now responsible for deferring the work,
    // but we call it immediately to ensure the initializationPromise is created.
    this._initialize().catch((error) => {
      console.error("Nexus initialization failed during scheduling", error);
    });
  }

  /**
   * Initialize the Nexus framework kernel.
   * This method is idempotent and defers the actual heavy work to the next event loop,
   * while immediately returning a Promise that can be awaited.
   */
  private _initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = deferToNextTick(async () => {
      this.lifecycleState = "snapshotting";
      const snapshot = this.createBootstrapSnapshot();
      if (snapshot.isErr()) {
        this.lifecycleState = "failed";
        this.terminalBootstrapError = snapshot.error;
        return Promise.reject(snapshot.error);
      }
      const initResult = await this.safeInitializeKernel(snapshot.value);
      if (initResult.isErr()) {
        this.lifecycleState = "failed";
        this.terminalBootstrapError = this.toBootstrapFailedError(
          initResult.error,
        );
        return Promise.reject(this.terminalBootstrapError);
      }
      this.lifecycleState = "ready";
      return undefined;
    }).catch((error) => {
      this.lifecycleState = "failed";
      this.terminalBootstrapError ??= this.toBootstrapFailedError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return Promise.reject(this.terminalBootstrapError);
    });

    return this.initializationPromise;
  }

  private createBootstrapSnapshot(): Result<
    {
      config: NexusConfig<U, P, string, string>;
      namedMatchers: ReadonlyMap<string, (identity: U) => boolean>;
      namedDescriptors: ReadonlyMap<string, Partial<U>>;
      decoratorSnapshot: DecoratorSnapshot;
      createFallbackConnectTo:
        | readonly TargetCriteria<U, string, string>[]
        | undefined;
    },
    Error
  > {
    if (this.config.endpoint?.implementation && this.config.implementation) {
      return err(
        new NexusConfigurationError(
          "Nexus: endpoint implementation is configured from multiple sources.",
          "E_CONFIGURATION_INVALID",
        ),
      );
    }

    const duplicateResult = this.validateProviderDuplicates(
      (this.config.services ?? []).map((registration) => ({
        token: registration.token as Token<object>,
        implementation: registration.implementation as object,
        policy: registration.policy,
      })),
      true,
      new Set(),
    );
    if (duplicateResult.isErr()) {
      return err(duplicateResult.error);
    }

    const decoratorSnapshot = this.copyDecoratorSnapshot(
      this.decoratorRegistry.snapshot(),
    );
    const bootstrapConfig = this.copyBootstrapConfig(this.config);

    return ok({
      config: bootstrapConfig,
      namedMatchers: new Map(this.namedMatchers),
      namedDescriptors: new Map(
        Array.from(this.namedDescriptors, ([name, descriptor]) => [
          name,
          this.copyPlainObject(descriptor),
        ]),
      ),
      decoratorSnapshot,
      createFallbackConnectTo: this.resolveCreateFallbackConnectTo(
        bootstrapConfig,
        decoratorSnapshot,
      ),
    });
  }

  private copyDecoratorSnapshot(
    snapshot: DecoratorSnapshot,
  ): DecoratorSnapshot {
    return {
      services: new Map(snapshot.services),
      endpoint: snapshot.endpoint
        ? {
            ...snapshot.endpoint,
            options: {
              ...snapshot.endpoint.options,
              meta: this.copyPlainObject(snapshot.endpoint.options.meta),
              connectTo: snapshot.endpoint.options.connectTo?.map((target) =>
                this.copyPlainObject(target),
              ),
            },
          }
        : null,
    };
  }

  private resolveCreateFallbackConnectTo(
    config: NexusConfig<U, P, string, string>,
    decoratorSnapshot: DecoratorSnapshot,
  ): readonly TargetCriteria<U, string, string>[] | undefined {
    return (
      config.endpoint?.connectTo ??
      decoratorSnapshot.endpoint?.options.connectTo
    );
  }

  private copyBootstrapConfig(
    config: NexusConfig<U, P, string, string>,
  ): NexusConfig<U, P, string, string> {
    const endpoint = config.endpoint
      ? {
          ...config.endpoint,
          meta: this.copyPlainObject(config.endpoint.meta) as U,
          connectTo: config.endpoint.connectTo?.map((target) =>
            this.copyPlainObject(target),
          ),
        }
      : undefined;

    return {
      ...config,
      endpoint,
      services: config.services?.map((registration) => ({
        token: registration.token,
        implementation: registration.implementation,
        policy: registration.policy,
      })),
    };
  }

  private copyPlainObject<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((item) => this.copyPlainObject(item)) as T;
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          typeof entry === "function" ? entry : this.copyPlainObject(entry),
        ]),
      ) as T;
    }
    return value;
  }

  private toBootstrapFailedError(error: Error): Error {
    if (
      "code" in error &&
      [
        "E_NEXUS_BOOTSTRAP_FAILED",
        "E_PROVIDER_BATCH_INVALID",
        "E_CONFIGURATION_INVALID",
      ].includes((error as { code: string }).code)
    ) {
      return error;
    }

    return new NexusConfigurationError(
      "Nexus: bootstrap has failed and this instance cannot be repaired in place.",
      "E_NEXUS_BOOTSTRAP_FAILED",
      {
        cause: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: "code" in error ? (error as { code: string }).code : undefined,
        },
      },
    );
  }

  private safeInitializeKernel(snapshot: {
    config: NexusConfig<U, P, string, string>;
    namedMatchers: ReadonlyMap<string, (identity: U) => boolean>;
    namedDescriptors: ReadonlyMap<string, Partial<U>>;
    decoratorSnapshot: DecoratorSnapshot;
    createFallbackConnectTo:
      | readonly TargetCriteria<U, string, string>[]
      | undefined;
  }): ResultAsync<void, Error> {
    if (this.engine) {
      return okAsync(undefined);
    }

    const builder = NexusKernelBuilder.create<U, P>(
      snapshot.config,
      snapshot.decoratorSnapshot.services,
      snapshot.decoratorSnapshot.endpoint,
      this,
      snapshot.namedMatchers,
      snapshot.namedDescriptors,
    );

    return builder.build().andThen((kernel) => {
      this.lifecycleState = "bootstrapping";
      return kernel.connectionManager.safeInitialize().map(() => {
        this.engine = kernel.engine;
        this.connectionManager = kernel.connectionManager;
        this.bootstrappedConnectToFallback = snapshot.createFallbackConnectTo;
      });
    });
  }

  private safeEnsureKernelReady(): ResultAsync<
    { engine: Engine<U, P>; connectionManager: ConnectionManager<U, P> },
    Error
  > {
    if (this.lifecycleState === "failed") {
      return errAsync(
        this.terminalBootstrapError ??
          new NexusConfigurationError(
            "Nexus: bootstrap has already failed.",
            "E_NEXUS_BOOTSTRAP_FAILED",
          ),
      );
    }

    this.scheduleInit();

    if (!this.initializationPromise) {
      return errAsync(
        new NexusConfigurationError(
          "Nexus: Initialization was not scheduled correctly.",
        ),
      );
    }

    return ResultAsync.fromPromise(this.initializationPromise, (error) =>
      error instanceof Error ? error : new Error(String(error)),
    ).andThen(() => {
      if (!this.engine || !this.connectionManager) {
        return errAsync(
          new NexusConfigurationError(
            "Nexus: Core is not initialized yet. Please check endpoint configuration.",
          ),
        );
      }

      return okAsync({
        engine: this.engine,
        connectionManager: this.connectionManager,
      });
    });
  }

  /**
   * Create a proxy for a remote service (unicast).
   * This method is async because it immediately attempts to resolve connections, and will
   * fail fast if a unique, suitable connection cannot be found.
   *
   * @param token Token object identifying the service contract
   * @param options Options for creating the proxy
   * @returns A Promise that resolves to the service proxy
   * @throws {NexusTargetingError} If no connection is found or multiple connections are found that do not meet expectations
   */
  public async create<T extends object>(
    token: Token<T>,
    options: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors> = {},
  ): Promise<Asyncified<T>> {
    return unwrapResultAsyncOrThrow(this.safeCreate(token, options));
  }

  public safeCreate<T extends object>(
    token: Token<T>,
    options: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors> = {},
  ): ResultAsync<Asyncified<T>, Error> {
    const validatedInput = validateCreateInput(token, options);
    if (validatedInput.isErr()) {
      return errAsync(
        new NexusUsageError(
          "Nexus: Invalid create() input.",
          "E_USAGE_INVALID",
          {
            cause: validatedInput.error,
          },
        ),
      );
    }

    const validatedToken = token;
    const validatedOptions = options;

    return this.safeEnsureKernelReady().andThen(
      ({ engine, connectionManager }) => {
        const finalTargetResult = TargetResolver.resolveUnicastTarget(
          validatedOptions.target,
          validatedToken.defaultCreate?.target as
            | CreateOptions<
                U,
                RegisteredMatchers,
                RegisteredDescriptors
              >["target"]
            | undefined,
          this.getCreateFallbackConnectTo(),
          validatedToken.id,
        );

        if (finalTargetResult.isErr()) {
          return errAsync(finalTargetResult.error);
        }

        const finalTarget = finalTargetResult.value;

        const { expects = "one", timeout } = validatedOptions;
        const resolvedTarget = TargetResolver.resolveNamedTarget(
          finalTarget,
          this.namedDescriptors,
          this.namedMatchers,
        );

        if (resolvedTarget.isErr()) {
          return errAsync(resolvedTarget.error);
        }

        return connectionManager
          .safeResolveConnections({
            descriptor: resolvedTarget.value.descriptor,
            matcher: resolvedTarget.value.matcher,
          })
          .andThen((connections) => {
            if (connections.length === 0) {
              return errAsync(
                new NexusTargetingError(
                  `Failed to create proxy for "${validatedToken.id}". No active connection found matching the criteria.`,
                  "E_TARGET_NO_MATCH",
                  { token: validatedToken.id, target: finalTarget },
                ),
              );
            }

            if (expects === "one" && connections.length !== 1) {
              return errAsync(
                new NexusTargetingError(
                  `Failed to create proxy for "${validatedToken.id}". Expected exactly one matching connection but found ${connections.length}.`,
                  "E_TARGET_UNEXPECTED_COUNT",
                  {
                    token: validatedToken.id,
                    target: finalTarget,
                    count: connections.length,
                  },
                ),
              );
            }

            const connection = connections[0];

            const proxyOptions: CreateProxyOptions<U> = {
              target: {
                connectionId: connection.connectionId,
              },
              staleTarget: {
                descriptor: resolvedTarget.value.descriptor,
                matcher: resolvedTarget.value.matcher,
              },
              strategy: expects,
              timeout,
            };

            return okAsync(
              engine.createServiceProxy<T>(
                validatedToken.id,
                proxyOptions,
              ) as Asyncified<T>,
            );
          });
      },
    );
  }

  private getCreateFallbackConnectTo():
    | readonly TargetCriteria<U, string, string>[]
    | undefined {
    return this.bootstrappedConnectToFallback;
  }

  /**
   * Create a multicast proxy for interacting with multiple remote services simultaneously.
   * This method will not fail due to inability to find connections.
   */
  public createMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "all",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(token: Token<T>, options: O): Promise<Allified<T>>;
  public createMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "stream",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(token: Token<T>, options: O): Promise<Streamified<T>>;
  public async createMulticast<T extends object>(
    token: Token<T>,
    options: CreateMulticastOptions<
      U,
      "all" | "stream",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  ): Promise<Allified<T> | Streamified<T>> {
    return unwrapResultAsyncOrThrow(
      this.safeCreateMulticastCore(token, options),
    );
  }

  private safeCreateMulticastCore<T extends object>(
    token: Token<T>,
    options: CreateMulticastOptions<
      U,
      "all" | "stream",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  ): ResultAsync<Allified<T> | Streamified<T>, Error> {
    const validatedInput = validateCreateMulticastInput(token, options);
    if (validatedInput.isErr()) {
      return errAsync(
        new NexusUsageError(
          "Nexus: Invalid createMulticast() input.",
          "E_USAGE_INVALID",
          { cause: validatedInput.error },
        ),
      );
    }

    const validatedToken = token;
    const validatedOptions = options;

    return this.safeEnsureKernelReady().andThen(({ engine }) => {
      const resolvedTarget = TargetResolver.resolveNamedTarget(
        validatedOptions.target,
        this.namedDescriptors,
        this.namedMatchers,
      );

      if (resolvedTarget.isErr()) {
        return errAsync(resolvedTarget.error);
      }

      const proxyOptions: CreateProxyOptions<U> = {
        target: buildMulticastProxyTarget(resolvedTarget.value),
        strategy: validatedOptions.expects ?? "all",
        timeout: validatedOptions.timeout,
      };

      return okAsync(
        engine.createServiceProxy<T>(validatedToken.id, proxyOptions) as
          | Allified<T>
          | Streamified<T>,
      );
    });
  }

  public safeCreateMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "all",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(token: Token<T>, options: O): ResultAsync<Allified<T>, Error>;
  public safeCreateMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "stream",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(token: Token<T>, options: O): ResultAsync<Streamified<T>, Error>;
  public safeCreateMulticast<T extends object>(
    token: Token<T>,
    options: CreateMulticastOptions<
      U,
      "all" | "stream",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  ): ResultAsync<Allified<T> | Streamified<T>, Error> {
    return this.safeCreateMulticastCore(token, options);
  }

  /**
   * Update partial metadata of the current endpoint and notify all connected peers.
   * @param updates An object containing the metadata fields to update.
   */
  public async updateIdentity(updates: Partial<U>): Promise<void> {
    return unwrapResultAsyncOrThrow(this.safeUpdateIdentity(updates));
  }

  public safeUpdateIdentity(updates: Partial<U>): ResultAsync<void, Error> {
    const validation = validateUpdateIdentityInput(
      updates as unknown as object,
    );
    if (validation.isErr()) {
      return errAsync(
        new NexusUsageError(
          "Nexus: Invalid updateIdentity() input.",
          "E_USAGE_INVALID",
          { cause: validation.error },
        ),
      );
    }

    return this.safeEnsureKernelReady().andThen(({ connectionManager }) => {
      const result = connectionManager.safeUpdateLocalIdentity(updates);
      if (result.isErr()) {
        return errAsync(result.error);
      }

      return okAsync(undefined);
    });
  }

  public ref<T extends object>(target: T): RefWrapper<T> {
    return unwrapResultOrThrow(this.safeRef(target));
  }

  public safeRef<T extends object>(target: T): Result<RefWrapper<T>, Error> {
    if (typeof target !== "object" || target === null) {
      return err(
        new NexusUsageError("Nexus.ref() can only be used with objects."),
      );
    }
    return ok({
      [REF_WRAPPER_SYMBOL]: true,
      target,
    });
  }

  public release(proxy: object): void {
    unwrapResultOrThrow(this.safeRelease(proxy));
  }

  public safeRelease(proxy: object): Result<void, Error> {
    if (
      proxy === null ||
      (typeof proxy !== "object" && typeof proxy !== "function")
    ) {
      return ok(undefined);
    }
    // @ts-expect-error - We are accessing a symbol property that may not exist.
    const releaseFn = proxy[RELEASE_PROXY_SYMBOL];
    if (typeof releaseFn === "function") {
      releaseFn();
    } else {
      console.warn(
        "Nexus.release() was called with an object that is not a valid Nexus proxy. The object was not released.",
      );
    }

    return ok(undefined);
  }
}

/**
 * Globally unique Nexus singleton instance.
 * All application configuration and operations should revolve around this singleton.
 */
export const nexus = new Nexus();

function buildMulticastProxyTarget<U extends UserMetadata>(resolvedTarget: {
  descriptor?: Partial<U>;
  matcher?: (identity: U) => boolean;
  groupName?: string;
}): CreateProxyOptions<U>["target"] {
  if (resolvedTarget.groupName) {
    return { groupName: resolvedTarget.groupName };
  }

  if (resolvedTarget.descriptor) {
    return {
      descriptor: resolvedTarget.descriptor,
      matcher: resolvedTarget.matcher,
    };
  }

  if (resolvedTarget.matcher) {
    return { matcher: resolvedTarget.matcher };
  }

  return {};
}

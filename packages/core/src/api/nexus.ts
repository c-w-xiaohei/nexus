import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import { merge } from "es-toolkit";
import {
  NexusConfig,
  CreateOptions,
  TargetMatcher,
  CreateMulticastOptions,
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
import { DecoratorRegistry } from "./registry";
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

const validateConfigureInput = fn(PlainObjectSchema, (input) => input);

const validateCreateInput = fn(
  args([
    ["token", z.object({ id: z.string() })],
    [
      "options",
      z.object({
        target: PlainObjectSchema,
        expects: z.enum(["one", "first"]).optional(),
        timeout: z.number().optional(),
      }),
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
  // Promise barrier for lazy initialization
  private initializationPromise: Promise<void> | null = null;
  private readonly decoratorRegistryOwner = Symbol("nexus-decorator-owner");
  // Added: state lock to ensure initialization is scheduled only once
  private isInitScheduled = false;

  // Named entity cache for performance optimization
  private readonly namedMatchers = new Map<string, (identity: U) => boolean>();
  private readonly namedDescriptors = new Map<string, Partial<U>>();

  public readonly matchers: MatcherUtils<U, RegisteredMatchers>;

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

    this.config = merge(this.config, config);

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
      const initResult = await this.safeInitializeKernel();
      if (initResult.isErr()) {
        return Promise.reject(initResult.error);
      }
      return undefined;
    }).catch((error) => {
      this.initializationPromise = null;
      this.isInitScheduled = false;
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    });

    return this.initializationPromise;
  }

  private safeInitializeKernel(): ResultAsync<void, Error> {
    if (this.engine) {
      return okAsync(undefined);
    }

    if (DecoratorRegistry.hasRegistrations()) {
      const claimed = DecoratorRegistry.claim(this.decoratorRegistryOwner);
      if (!claimed) {
        return errAsync(
          new NexusConfigurationError(
            "Nexus: Decorator-based bootstrapping is process-global. Only one Nexus instance can consume decorator registrations. For multi-instance setups, use configure({ services, endpoint }) instead.",
          ),
        );
      }
    }

    const decoratorSnapshot = DecoratorRegistry.snapshot();
    const builder = NexusKernelBuilder.create<U, P>(
      this.config,
      decoratorSnapshot.services,
      decoratorSnapshot.endpoint,
      this,
      this.namedMatchers,
      this.namedDescriptors,
    );

    return builder.build().andThen((kernel) => {
      const cmInitResult = kernel.connectionManager.safeInitialize();
      if (cmInitResult.isErr()) {
        return errAsync(cmInitResult.error);
      }

      this.engine = kernel.engine;
      this.connectionManager = kernel.connectionManager;
      DecoratorRegistry.clear();
      return okAsync(undefined);
    });
  }

  private safeEnsureKernelReady(): ResultAsync<
    { engine: Engine<U, P>; connectionManager: ConnectionManager<U, P> },
    Error
  > {
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
    options: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>,
  ): Promise<Asyncified<T>> {
    return unwrapResultAsyncOrThrow(this.safeCreate(token, options));
  }

  public safeCreate<T extends object>(
    token: Token<T>,
    options: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>,
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
          validatedToken.defaultTarget as
            | CreateOptions<
                U,
                RegisteredMatchers,
                RegisteredDescriptors
              >["target"]
            | undefined,
          this.config.endpoint?.connectTo,
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
          .safeResolveConnection({
            descriptor: resolvedTarget.value.descriptor,
            matcher: resolvedTarget.value.matcher,
          })
          .andThen((connection) => {
            if (!connection) {
              return errAsync(
                new NexusTargetingError(
                  `Failed to create proxy for "${validatedToken.id}". No active connection found matching the criteria.`,
                  "E_TARGET_NO_MATCH",
                  { token: validatedToken.id, target: finalTarget },
                ),
              );
            }

            const proxyOptions: CreateProxyOptions<U> = {
              target: {
                connectionId: connection.connectionId,
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
export const nexus: NexusInstance<any, any> = new Nexus();

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

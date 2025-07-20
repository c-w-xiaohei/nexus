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
import { NexusTargetingError } from "@/errors";

// Type utilities for extracting matcher and descriptor names from config objects
type GetMatchers<T> = T extends { matchers: infer M }
  ? keyof M & string
  : never;
type GetDescriptors<T> = T extends { descriptors: infer D }
  ? keyof D & string
  : never;

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
> implements NexusInstance<U, P, RegisteredMatchers, RegisteredDescriptors>
{
  // L3 engine instance, lazily initialized
  private engine: Engine<U, P> | null = null;
  // L2 connection manager instance, lazily initialized
  private connectionManager: ConnectionManager<U, P> | null = null;
  // Stores the merged configuration
  private config: NexusConfig<U, P, any, any> = {} as any;
  // Promise barrier for lazy initialization
  private initializationPromise: Promise<void> | null = null;
  // Added: state lock to ensure initialization is scheduled only once
  private isInitScheduled = false;

  // Named entity cache for performance optimization
  private readonly namedMatchers = new Map<string, (identity: U) => boolean>();
  private readonly namedDescriptors = new Map<string, Partial<U>>();

  public readonly matchers: MatcherUtils<U, RegisteredMatchers>;

  constructor() {
    this.matchers = {
      and: (...matchers: TargetMatcher<U, RegisteredMatchers>[]) => {
        return (identity: U) => {
          for (const matcher of matchers) {
            const fn =
              typeof matcher === "string"
                ? this.namedMatchers.get(matcher)
                : matcher;
            if (!fn || !fn(identity)) {
              return false;
            }
          }
          return true;
        };
      },
      or: (...matchers: TargetMatcher<U, RegisteredMatchers>[]) => {
        return (identity: U) => {
          for (const matcher of matchers) {
            const fn =
              typeof matcher === "string"
                ? this.namedMatchers.get(matcher)
                : matcher;
            if (fn?.(identity)) {
              return true;
            }
          }
          return false;
        };
      },
      not: (matcher: TargetMatcher<U, RegisteredMatchers>) => {
        return (identity: U) => {
          const fn =
            typeof matcher === "string"
              ? this.namedMatchers.get(matcher)
              : matcher;
          return !fn?.(identity);
        };
      },
    };
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
    config: T
  ): NexusInstance<
    U,
    P,
    RegisteredMatchers | GetMatchers<T>,
    RegisteredDescriptors | GetDescriptors<T>
  > {
    // 1. Implement deep merge logic for configuration
    this.config = merge(this.config, config);

    // 2. Update internal cache
    if (config.matchers) {
      for (const [name, matcher] of Object.entries(config.matchers)) {
        this.namedMatchers.set(name, matcher as (identity: U) => boolean);
      }
    }
    if (config.descriptors) {
      for (const [name, descriptor] of Object.entries(config.descriptors)) {
        this.namedDescriptors.set(name, descriptor as Partial<U>);
      }
    }

    // 3. Schedule initialization (if not already scheduled)
    this.scheduleInit();

    // “欺骗” TS 编译器，让它相信类型已增强
    return this as any;
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
    this._initialize();
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

    this.initializationPromise = new Promise((resolve) => {
      // Defer heavy lifting to the next event loop tick to allow all
      // synchronous `configure` calls to complete.
      setTimeout(async () => {
        if (this.engine) {
          // Should not happen if guard works, but as a failsafe.
          return resolve();
        }

        // 1. Pass configuration, data from the new static registry, and self instance to Builder
        const builder = new NexusKernelBuilder<U, P>(
          this.config,
          DecoratorRegistry.services,
          DecoratorRegistry.endpoint,
          this,
          this.namedMatchers,
          this.namedDescriptors
        );

        // 2. Wait for Builder to complete all complex construction work
        const kernel = await builder.build();

        // 3. Receive build results
        this.engine = kernel.engine;
        this.connectionManager = kernel.connectionManager;

        // 4. Activate kernel
        this.connectionManager.initialize();
        resolve();
      }, 0);
    });

    return this.initializationPromise;
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
    options: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>
  ): Promise<Asyncified<T>> {
    // 1. Ensure initialization is complete
    this.scheduleInit();
    await this.initializationPromise;

    // 2. Determine final addressing target (including fallback logic)
    let finalTarget: any = options.target;

    // A little helper to check if a target is empty
    const isTargetEmpty = (t: any) => !t || Object.keys(t).length === 0;

    if (isTargetEmpty(finalTarget)) {
      finalTarget = token.defaultTarget;
    }

    if (isTargetEmpty(finalTarget)) {
      const defaultTargets = this.config.endpoint?.connectTo;
      if (defaultTargets?.length === 1) {
        finalTarget = defaultTargets[0];
      } else if (defaultTargets && defaultTargets.length > 1) {
        // This is the case the "ambiguous" test is looking for.
        throw new Error(
          `Nexus: Default target is ambiguous. ${defaultTargets.length} targets are defined in 'connectTo'. Please specify a 'target' explicitly in create().`
        );
      }
    }

    if (isTargetEmpty(finalTarget)) {
      throw new NexusTargetingError(
        `Nexus: No target specified for creating proxy for token "${token.id}". A target must be provided either in create() options, the Token, or a unique 'connectTo' endpoint config.`,
        "E_TARGET_NO_MATCH",
        { token: token.id, target: options.target }
      );
    }

    // 3. Resolve named entities
    const { expects = "one", timeout } = options;
    const { descriptor: descriptorOrName, matcher: matcherOrName } =
      finalTarget;

    const finalDescriptor =
      typeof descriptorOrName === "string"
        ? this.namedDescriptors.get(descriptorOrName)
        : descriptorOrName;
    const finalMatcher =
      typeof matcherOrName === "string"
        ? this.namedMatchers.get(matcherOrName)
        : matcherOrName;

    if (
      descriptorOrName &&
      typeof descriptorOrName === "string" &&
      !finalDescriptor
    ) {
      throw new Error(
        `Nexus: Descriptor with name "${descriptorOrName}" not found.`
      );
    }
    if (matcherOrName && typeof matcherOrName === "string" && !finalMatcher) {
      throw new Error(`Nexus: Matcher with name "${matcherOrName}" not found.`);
    }

    // 4. Immediately resolve connection (core logic)
    const connection = await this.connectionManager!.resolveConnection({
      descriptor: finalDescriptor,
      matcher: finalMatcher,
    });

    // 5. Apply "fail fast" strategy
    if (!connection) {
      throw new NexusTargetingError(
        `Failed to create proxy for "${token.id}". No active connection found matching the criteria.`,
        "E_TARGET_NO_MATCH",
        { token: token.id, target: finalTarget }
      );
    }
    // Note: `resolveConnection` internally handles the case when 'expects: "one"' finds multiple,
    // here we trust it can guarantee returning unique or null.

    // 6. Build CreateProxyOptions needed by L3, target is now precisely bound
    const proxyOptions: CreateProxyOptions<U> = {
      target: {
        connectionId: connection.connectionId,
      },
      strategy: expects,
      timeout,
    };

    // 7. Call engine to create and return proxy
    return this.engine!.createServiceProxy<T>(
      token.id,
      proxyOptions
    ) as Asyncified<T>;
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
      any,
      RegisteredMatchers,
      RegisteredDescriptors
    >
  ): Promise<any> {
    // 1. Ensure initialization is complete
    this.scheduleInit();
    await this.initializationPromise;

    // 2. Resolve final addressing target (target)
    // The logic here is similar to the old create, but simpler because it doesn't handle connection binding
    const {
      descriptor: descriptorOrName,
      matcher: matcherOrName,
      groupName,
    } = options.target;

    const finalDescriptor =
      typeof descriptorOrName === "string"
        ? this.namedDescriptors.get(descriptorOrName)
        : (descriptorOrName as Partial<U> | undefined);

    const finalMatcher =
      typeof matcherOrName === "string"
        ? this.namedMatchers.get(matcherOrName)
        : (matcherOrName as ((identity: U) => boolean) | undefined);

    if (
      descriptorOrName &&
      typeof descriptorOrName === "string" &&
      !finalDescriptor
    ) {
      throw new Error(
        `Nexus: Descriptor with name "${descriptorOrName}" not found.`
      );
    }
    if (matcherOrName && typeof matcherOrName === "string" && !finalMatcher) {
      throw new Error(`Nexus: Matcher with name "${matcherOrName}" not found.`);
    }

    // 3. Build CreateProxyOptions needed by L3, ensuring target object is clean
    const messageTarget: any = {};
    if (finalDescriptor) messageTarget.descriptor = finalDescriptor;
    if (finalMatcher) messageTarget.matcher = finalMatcher;
    if (groupName) messageTarget.groupName = groupName;

    const proxyOptions: CreateProxyOptions<U> = {
      target: messageTarget,
      strategy: options.expects ?? "all",
      timeout: options.timeout,
    };

    // 4. Call engine to create and return proxy
    return this.engine!.createServiceProxy<T>(token.id, proxyOptions);
  }

  /**
   * Update partial metadata of the current endpoint and notify all connected peers.
   * @param updates An object containing the metadata fields to update.
   */
  public updateIdentity(updates: Partial<U>): void {
    // Ensure initialization is scheduled and wait for completion in a fire-and-forget manner
    this.scheduleInit();
    this.initializationPromise?.then(() => {
      this.connectionManager!.updateLocalIdentity(updates);
    });
  }

  public ref<T extends object>(target: T): RefWrapper<T> {
    if (typeof target !== "object" || target === null) {
      throw new Error("Nexus.ref() can only be used with objects.");
    }
    return {
      [REF_WRAPPER_SYMBOL]: true,
      target,
    };
  }

  public release(proxy: object): void {
    if (
      proxy === null ||
      (typeof proxy !== "object" && typeof proxy !== "function")
    ) {
      return;
    }
    // @ts-expect-error - We are accessing a symbol property that may not exist.
    const releaseFn = proxy[RELEASE_PROXY_SYMBOL];
    if (typeof releaseFn === "function") {
      releaseFn();
    } else {
      console.warn(
        "Nexus.release() was called with an object that is not a valid Nexus proxy. The object was not released."
      );
    }
  }
}

/**
 * Globally unique Nexus singleton instance.
 * All application configuration and operations should revolve around this singleton.
 */
export const nexus: NexusInstance<any, any> = new Nexus();

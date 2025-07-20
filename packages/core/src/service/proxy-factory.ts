import type { PlatformMetadata, UserMetadata } from "../types/identity";
import type { Engine } from "./engine";
import { DispatchCallOptions } from "./engine";
import type { ResourceManager } from "./resource-manager";
import type { CallTarget } from "@/connection/types";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { Logger } from "@/logger";
type ReleaseContext = {
  resourceId: string;
  connectionId: string;
};

/**
 * Options for creating a service proxy, specifying the target and behavior.
 */
export interface CreateProxyOptions<U extends UserMetadata> {
  target: CallTarget<U, any>;
  strategy?: "one" | "first" | "all" | "stream";
  timeout?: number;
  broadcastOptions?: {
    strategy: "all" | "first" | "stream";
  };
}

/**
 * A factory responsible for creating all types of proxy objects used within Nexus.
 * It encapsulates the complexity of setting up proxy traps and managing their
 * registration with the ResourceManager.
 */
export class ProxyFactory<U extends UserMetadata, P extends PlatformMetadata> {
  private readonly releaseRegistry: FinalizationRegistry<ReleaseContext>;
  private readonly logger: Logger = new Logger("L3 -> ProxyFactory");

  constructor(
    // Dependencies
    private readonly engine: Engine<U, P>,
    private readonly resourceManager: ResourceManager
  ) {
    this.releaseRegistry = new FinalizationRegistry(
      ({ resourceId, connectionId }) => {
        // This callback is triggered when a remote resource proxy is garbage collected.
        // We notify the original owner of the resource that it can be released.
        this.engine.dispatchRelease(resourceId, connectionId);
      }
    );
  }

  /**
   * Creates the top-level service proxy that the user interacts with.
   * e.g., const myApi = nexus.create<MyApi>({ ... });
   */
  public createServiceProxy<T extends object>(
    // The name of the service this proxy should be bound to.
    serviceName: string,
    // Can be a specific connection or null for broadcast/auto-discovery.
    // The Engine will handle the routing logic.
    options: CreateProxyOptions<U>
  ): T {
    // Determine the effective strategy from either strategy or broadcastOptions
    const effectiveStrategy =
      options.strategy ?? options.broadcastOptions?.strategy;
    const createProxy = (path: (string | number)[]): any => {
      // The proxy target is a dummy function. The real logic is in the handlers.
      const proxy = new Proxy(() => {}, {
        get: (_target, prop, receiver) => {
          if (prop === "then") {
            // This makes the proxy "awaitable". Awaiting the proxy triggers a
            // GET request for the current path.

            // A service root proxy (e.g., `nexus.create<MyApi>`) should NOT be
            // thenable. Awaiting it is not a valid operation. Only awaiting a
            // property on it is (e.g., `await myApi.someProperty`).
            if (path.length <= 1) {
              return undefined;
            }

            // For broadcast targets, direct property access should likely be disallowed
            // or return a new proxy that also broadcasts. For now, we proceed,
            // treating GET as a standard call.
            const callOptions: DispatchCallOptions = {
              type: "GET",
              target: options.target,
              resourceId: null, // Null for service calls
              path,
              strategy: effectiveStrategy,
              timeout: options.timeout,
              proxyOptions: options, // Pass proxy's creation options
            };
            const promiseOrIter = this.engine.dispatchCall(callOptions);

            // If it's a promise, make the proxy "thenable".
            if (promiseOrIter instanceof Promise) {
              return promiseOrIter.then.bind(promiseOrIter);
            }
            // If it's an async iterator, it's not "thenable" in the classic sense.
            // Awaiting a property that returns a stream is an anti-pattern.
            return undefined;
          }

          // Allows for `nexus.release(proxy)` style manual GC
          if (prop === RELEASE_PROXY_SYMBOL) {
            // Service proxies are not tied to a single resource, so they cannot be released.
            return () =>
              console.warn(
                `Nexus: A service proxy cannot be released. This function is for resource proxies only.`
              );
          }

          // Intercept properties used for internals or inspection by frameworks.
          // This prevents JS internal operations (like console.log or test assertions)
          // from being treated as RPC calls.
          if (
            typeof prop === "symbol" ||
            prop === "constructor" ||
            prop === "inspect" ||
            prop === "valueOf" ||
            prop === "toString" ||
            prop === "nodeType" || // Common in test environments
            prop === "then" // Already handled, but good to have here
          ) {
            return Reflect.get(_target, prop, receiver);
          }

          // For all other properties, continue chaining by returning a new proxy.
          return createProxy([...path, prop]);
        },
        apply: (_target, _thisArg, args) => {
          // This is a method call. The `path` contains the full method access chain.
          // The engine will wrap this in an APPLY message and send it.
          const callOptions: DispatchCallOptions = {
            type: "APPLY",
            target: options.target,
            resourceId: null, // Null for top-level service calls
            path,
            args,
            strategy: effectiveStrategy,
            timeout: options.timeout,
            proxyOptions: options, // Pass proxy's creation options
          };
          // The return value could be a Promise or an AsyncIterable, so we cast to any.
          return this.engine.dispatchCall(callOptions as any);
        },
      });
      return proxy;
    };
    // This is the key change: the proxy is created with the serviceName
    // as its base path, so all subsequent property accesses are relative to it.
    return createProxy([serviceName]) as T;
  }

  /**
   * Creates a local proxy to represent a resource that exists on a remote endpoint.
   * This is called during the "revival" of parameters.
   * @param resourceId The ID of the remote resource.
   * @param sourceConnectionId The connection where the original resource lives.
   */
  public createRemoteResourceProxy(
    resourceId: string,
    sourceConnectionId: string
  ): object {
    const createProxy = (path: (string | number)[]): any => {
      // The proxy target is a dummy function. The real logic is in the handlers.
      const proxy = new Proxy(() => {}, {
        get: (_target, prop, receiver) => {
          // Allows for `await proxy.property`
          if (prop === "then") {
            // Awaiting the root proxy itself is not a valid operation.
            if (path.length === 0) {
              return undefined;
            }
            // Awaiting a property access translates to a GET request.
            const callOptions: DispatchCallOptions = {
              type: "GET",
              target: { connectionId: sourceConnectionId },
              resourceId,
              path,
            };
            const promise = this.engine.dispatchCall(callOptions);
            return promise.then.bind(promise);
          }

          // New handler for the release symbol
          if (prop === RELEASE_PROXY_SYMBOL) {
            this.logger.debug(
              `Releasing resource proxy ${resourceId} on connection ${sourceConnectionId}`
            );
            return () =>
              this.engine.dispatchRelease(resourceId, sourceConnectionId);
          }

          // Intercept properties used for internals or inspection by frameworks.
          // This prevents JS internal operations (like console.log or test assertions)
          // from being treated as RPC calls.
          if (
            typeof prop === "symbol" ||
            prop === "constructor" ||
            prop === "inspect" ||
            prop === "valueOf" ||
            prop === "toString" ||
            prop === "nodeType" || // Common in test environments
            prop === "then" // Already handled, but good to have here
          ) {
            this.logger.debug(
              `Get a internal property: ${typeof prop === "symbol" ? "symbol" : prop}`
            );
            return Reflect.get(_target, prop, receiver);
          }

          // For all other properties, continue chaining by returning a new proxy.
          return createProxy([...path, prop]);
        },
        set: (_target, prop, value) => {
          // A set operation terminates a proxy chain.
          const setPath = [...path, prop as string];
          const callOptions: DispatchCallOptions = {
            type: "SET",
            target: { connectionId: sourceConnectionId },
            resourceId,
            path: setPath,
            value,
          };
          this.engine.dispatchCall(callOptions);
          // The `set` trap must return true to indicate success.
          return true;
        },
        apply: (_target, _thisArg, args) => {
          // An apply operation terminates a proxy chain.
          const callOptions: DispatchCallOptions = {
            type: "APPLY",
            target: { connectionId: sourceConnectionId },
            resourceId,
            path,
            args,
          };
          return this.engine.dispatchCall(callOptions);
        },
      });
      return proxy;
    };

    // Create the root proxy with an empty path.
    const rootProxy = createProxy([]);

    // Register the root proxy with the FinalizationRegistry for automatic GC.
    this.releaseRegistry.register(rootProxy, {
      resourceId,
      connectionId: sourceConnectionId,
    });

    // Also register it with the ResourceManager for manual/connection-level GC.
    this.resourceManager.registerRemoteProxy(
      resourceId,
      rootProxy,
      sourceConnectionId
    );

    return rootProxy;
  }
}

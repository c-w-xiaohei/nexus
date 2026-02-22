import type { UserMetadata } from "../types/identity";
import type { DispatchCallOptions } from "./engine";
import type { ResourceManager } from "./resource-manager";
import type { CallTarget } from "@/connection/types";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { Logger } from "@/logger";
import type { ResultAsync } from "neverthrow";

type ReleaseContext = {
  resourceId: string;
  connectionId: string;
};

const INTERNAL_PROXY_PROPERTIES = new Set([
  "constructor",
  "inspect",
  "valueOf",
  "toString",
  "nodeType",
]);

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

export interface ProxyFactoryCallbacks {
  safeDispatchCall(
    options: DispatchCallOptions,
  ): ResultAsync<any, globalThis.Error>;
  dispatchRelease(resourceId: string, connectionId: string): void;
}

type ChainableProxyConfig = {
  basePath: (string | number)[];
  thenableFromPathLength: number;
  hasSetter?: boolean;
  onRelease?: () => void;
  buildCallOptions: {
    (type: "GET", path: (string | number)[]): DispatchCallOptions;
    (
      type: "SET",
      path: (string | number)[],
      extra: { value: any },
    ): DispatchCallOptions;
    (
      type: "APPLY",
      path: (string | number)[],
      extra: { args: any[] },
    ): DispatchCallOptions;
  };
};

/**
 * A factory responsible for creating all types of proxy objects used within Nexus.
 * It encapsulates the complexity of setting up proxy traps and managing their
 * registration with the ResourceManager.
 */
export class ProxyFactory<U extends UserMetadata> {
  private readonly releaseRegistry: FinalizationRegistry<ReleaseContext>;
  private readonly logger: Logger = new Logger("L3 -> ProxyFactory");

  constructor(
    private readonly engine: ProxyFactoryCallbacks,
    private readonly resourceManager: ResourceManager.Runtime,
  ) {
    this.releaseRegistry = new FinalizationRegistry(
      ({ resourceId, connectionId }) => {
        this.engine.dispatchRelease(resourceId, connectionId);
      },
    );
  }

  private trackFireAndForget<T>(value: T): T {
    if (value instanceof Promise) {
      value.catch((error) =>
        this.logger.error("Fire-and-forget proxy call failed", error),
      );
    }
    return value;
  }

  private unwrapResultAsync<T>(
    value: ResultAsync<T, globalThis.Error>,
  ): Promise<T> {
    return value.match(
      (okValue) => okValue,
      (error) => {
        this.logger.error("Safe call failed", error);
        throw error;
      },
    );
  }

  private isInternalAccess(prop: string | symbol): boolean {
    return (
      typeof prop === "symbol" || INTERNAL_PROXY_PROPERTIES.has(prop as string)
    );
  }

  private createChainableProxy(config: ChainableProxyConfig): any {
    const createProxy = (path: (string | number)[]): any => {
      return new Proxy(() => {}, {
        get: (_target, prop, receiver) => {
          if (prop === "then") {
            if (path.length < config.thenableFromPathLength) {
              return undefined;
            }

            const result = this.engine.safeDispatchCall(
              config.buildCallOptions("GET", path),
            );
            const unwrapped = this.unwrapResultAsync(result);
            return unwrapped.then.bind(unwrapped);
          }

          if (prop === RELEASE_PROXY_SYMBOL) {
            return (
              config.onRelease ??
              (() =>
                console.warn(
                  "Nexus: A service proxy cannot be released. This function is for resource proxies only.",
                ))
            );
          }

          if (this.isInternalAccess(prop)) {
            return Reflect.get(_target, prop, receiver);
          }

          return createProxy([...path, prop as string]);
        },
        apply: (_target, _thisArg, args) =>
          this.trackFireAndForget(
            this.unwrapResultAsync(
              this.engine.safeDispatchCall(
                config.buildCallOptions("APPLY", path, { args }),
              ),
            ),
          ),
        ...(config.hasSetter
          ? {
              set: (_target: any, prop: string | symbol, value: any) => {
                this.trackFireAndForget(
                  this.unwrapResultAsync(
                    this.engine.safeDispatchCall(
                      config.buildCallOptions(
                        "SET",
                        [...path, prop as string],
                        {
                          value,
                        },
                      ),
                    ),
                  ),
                );
                return true;
              },
            }
          : {}),
      });
    };

    return createProxy(config.basePath);
  }

  /**
   * Creates the top-level service proxy that the user interacts with.
   * e.g., const myApi = nexus.create<MyApi>({ ... });
   */
  public createServiceProxy<T extends object>(
    serviceName: string,
    options: CreateProxyOptions<U>,
  ): T {
    const strategy = options.strategy ?? options.broadcastOptions?.strategy;

    return this.createChainableProxy({
      basePath: [serviceName],
      thenableFromPathLength: 2,
      buildCallOptions: (
        type: "GET" | "SET" | "APPLY",
        path: (string | number)[],
        extra?: { args?: any[]; value?: any },
      ): DispatchCallOptions => {
        switch (type) {
          case "GET":
            return {
              type,
              target: options.target,
              resourceId: null,
              path,
              strategy,
              timeout: options.timeout,
              proxyOptions: options,
            };
          case "SET":
            return {
              type,
              target: options.target,
              resourceId: null,
              path,
              strategy,
              timeout: options.timeout,
              proxyOptions: options,
              value: extra?.value,
            } as DispatchCallOptions;
          case "APPLY":
            return {
              type,
              target: options.target,
              resourceId: null,
              path,
              strategy,
              timeout: options.timeout,
              proxyOptions: options,
              args: extra?.args ?? [],
            };
        }
      },
    }) as T;
  }

  /**
   * Creates a local proxy to represent a resource that exists on a remote endpoint.
   * This is called during the "revival" of parameters.
   */
  public createRemoteResourceProxy(
    resourceId: string,
    sourceConnectionId: string,
  ): object {
    const rootProxy = this.createChainableProxy({
      basePath: [],
      thenableFromPathLength: 1,
      hasSetter: true,
      onRelease: () =>
        this.engine.dispatchRelease(resourceId, sourceConnectionId),
      buildCallOptions: (
        type: "GET" | "SET" | "APPLY",
        path: (string | number)[],
        extra?: { args?: any[]; value?: any },
      ): DispatchCallOptions => {
        switch (type) {
          case "GET":
            return {
              type,
              target: { connectionId: sourceConnectionId },
              resourceId,
              path,
            };
          case "SET":
            return {
              type,
              target: { connectionId: sourceConnectionId },
              resourceId,
              path,
              value: extra?.value,
            } as DispatchCallOptions;
          case "APPLY":
            return {
              type,
              target: { connectionId: sourceConnectionId },
              resourceId,
              path,
              args: extra?.args ?? [],
            };
        }
      },
    });

    this.releaseRegistry.register(rootProxy, {
      resourceId,
      connectionId: sourceConnectionId,
    });

    this.resourceManager.registerRemoteProxy(
      resourceId,
      rootProxy,
      sourceConnectionId,
    );

    return rootProxy;
  }
}

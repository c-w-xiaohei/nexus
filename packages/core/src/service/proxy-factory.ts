import type { AdapterModel, ConnectionWhere } from "@/types/adapter-model";
import type {
  CallBinding,
  DispatchCallOptions,
  ProxyOperation,
} from "./call-processor";
import type { ResourceManager } from "./resource-manager";
import {
  RELEASE_PROXY_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "@/types/symbols";
import { Logger } from "@/logger";
import type { Result } from "better-result";
import { NexusResourceError } from "@/errors/resource-errors";

type ReleaseContext = { resourceId: string; connectionId: string };
type ProxyScope = {
  binding: CallBinding;
  basePath: (string | number)[];
  resourceId: string | null;
  released: boolean;
  release: () => void;
};
type ProxyTarget = () => void;

const INTERNAL_PROXY_PROPERTIES = new Set([
  "constructor",
  "inspect",
  "valueOf",
  "toString",
  "nodeType",
]);
const isLifecycleSymbol = (prop: PropertyKey): boolean =>
  prop === NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL ||
  prop === NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL;
const releaseServiceProxy = () =>
  console.warn(
    "Nexus: A service proxy cannot be released. This function is for resource proxies only.",
  );

/** Fixed dispatch binding; staleTarget is observation policy consumed by Engine. */
export type CreateProxyOptions<M extends AdapterModel> = CallBinding & {
  staleTarget?: { where?: ConnectionWhere<M> };
};

export interface ProxyFactoryCallbacks {
  safeDispatchCall(options: DispatchCallOptions): Promise<Result<any, Error>>;
  dispatchRelease(resourceId: string, connectionId: string): void;
}

/**
 * Creates session-bound facades and shares one set of Proxy trap methods.
 * Weak target metadata carries each path and keeps the resource scope alive without
 * making the factory retain user proxies. Only resource release needs a bound callback.
 */
export class ProxyFactory<
  M extends AdapterModel,
> implements ProxyHandler<ProxyTarget> {
  private readonly targets = new WeakMap<
    ProxyTarget,
    { scope: ProxyScope; path: (string | number)[] }
  >();
  private readonly remoteProxyScopes = new WeakMap<object, ProxyScope>();
  private readonly releaseRegistry: FinalizationRegistry<ReleaseContext>;
  private readonly logger = new Logger("L3 -> ProxyFactory");

  constructor(
    private readonly engine: ProxyFactoryCallbacks,
    private readonly resourceManager: ResourceManager.Runtime,
  ) {
    this.releaseRegistry = new FinalizationRegistry(
      ({ resourceId, connectionId }) => {
        this.resourceManager.releaseRemoteProxy(resourceId, connectionId);
        this.engine.dispatchRelease(resourceId, connectionId);
      },
    );
  }

  /** Captures the session snapshot; Engine installs lifecycle observation on unicast roots. */
  public createServiceProxy<T extends object>(
    serviceName: string,
    options: CreateProxyOptions<M>,
  ): T {
    const binding: CallBinding =
      options.strategy === "one"
        ? {
            target: { connectionId: options.target.connectionId },
            strategy: "one",
            timeout: options.timeout,
          }
        : {
            target: { connectionIds: [...options.target.connectionIds] },
            strategy: options.strategy,
            timeout: options.timeout,
          };
    const scope: ProxyScope = {
      binding,
      basePath: [serviceName],
      resourceId: null,
      released: false,
      release: releaseServiceProxy,
    };
    return this.createProxy(scope, scope.basePath) as T;
  }

  /**
   * Revives one capability. Every child path retains the same scope/finalizer anchor.
   * Explicit release is idempotent; local resource IDs never determine remote ownership.
   */
  public createRemoteResourceProxy(
    resourceId: string,
    connectionId: string,
  ): object {
    const scope: ProxyScope = {
      binding: { target: { connectionId }, strategy: "one", timeout: 5000 },
      basePath: [],
      resourceId,
      released: false,
      release: () => {
        if (scope.released) return;
        scope.released = true;
        this.discardRemoteResourceProxy(proxy);
        this.resourceManager.releaseRemoteProxy(resourceId, connectionId);
        this.engine.dispatchRelease(resourceId, connectionId);
      },
    };
    const proxy = this.createProxy(scope, scope.basePath);
    // Registry held values must never reference the scope or any facade.
    this.releaseRegistry.register(scope, { resourceId, connectionId }, scope);
    this.resourceManager.registerRemoteProxy(resourceId, connectionId);
    this.remoteProxyScopes.set(proxy, scope);
    return proxy;
  }

  /** Drops this facade's finalizer, leaving a pre-existing shared resource identity intact. */
  public discardRemoteResourceProxy(proxy: object): void {
    const scope = this.remoteProxyScopes.get(proxy);
    if (!scope) return;
    this.releaseRegistry.unregister(scope);
    this.remoteProxyScopes.delete(proxy);
  }

  // ===== Shared Proxy traps: only paths/scopes vary between facades =====

  /** Roots are not thenable; awaiting a child path dispatches GET. Symbols remain local. */
  public get(
    target: ProxyTarget,
    prop: string | symbol,
    receiver: unknown,
  ): any {
    const { scope, path } = this.targets.get(target)!;
    if (prop === "then") {
      if (path.length === scope.basePath.length) return undefined;
      const result = this.dispatch(scope, { type: "GET", path });
      return result.then.bind(result);
    }
    if (
      prop === RELEASE_PROXY_SYMBOL ||
      (prop === Symbol.dispose && scope.resourceId !== null)
    ) {
      return scope.release;
    }
    if (isLifecycleSymbol(prop)) return Reflect.get(target, prop);
    if (typeof prop === "symbol" || INTERNAL_PROXY_PROPERTIES.has(prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return this.createProxy(scope, [...path, prop]);
  }

  /** Calls immediately but observes rejection even when application code forgets to await. */
  public apply(
    target: ProxyTarget,
    _thisArg: unknown,
    args: any[],
  ): Promise<any> {
    const { scope, path } = this.targets.get(target)!;
    return this.trackFireAndForget(
      this.dispatch(scope, { type: "APPLY", path, args }),
    );
  }

  public set(target: ProxyTarget, prop: string | symbol, value: any): boolean {
    if (isLifecycleSymbol(prop)) {
      Reflect.set(target, prop, value);
      return true;
    }
    const { scope, path } = this.targets.get(target)!;
    if (scope.resourceId === null) return false;
    // SET cannot return a Promise: released resources must throw from the trap itself.
    this.assertActive(scope);
    this.trackFireAndForget(
      this.dispatch(scope, {
        type: "SET",
        path: [...path, prop as string],
        value,
      }),
    );
    return true;
  }

  private createProxy(scope: ProxyScope, path: (string | number)[]): any {
    const target = () => {};
    this.targets.set(target, { scope, path });
    return new Proxy(target, this);
  }

  /** Async throw-style boundary: GET/APPLY failures reject, without duplicate trap-level catch branches. */
  private async dispatch(
    scope: ProxyScope,
    operation: ProxyOperation,
  ): Promise<any> {
    try {
      this.assertActive(scope);
      const result = await this.engine.safeDispatchCall({
        ...scope.binding,
        resourceId: scope.resourceId,
        ...operation,
      });
      if (result.isErr()) throw result.error;
      return result.value;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private assertActive(scope: ProxyScope): void {
    if (scope.released)
      throw new NexusResourceError(
        `Remote resource proxy "${scope.resourceId}" has been released and is no longer usable.`,
        "E_RESOURCE_ACCESS_DENIED",
        {
          resourceId: scope.resourceId,
          connectionId:
            "connectionId" in scope.binding.target
              ? scope.binding.target.connectionId
              : undefined,
        },
      );
  }

  private trackFireAndForget<T>(promise: Promise<T>): Promise<T> {
    promise.catch((error) =>
      this.logger.error("Fire-and-forget proxy call failed", error),
    );
    return promise;
  }
}

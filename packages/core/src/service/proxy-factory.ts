import type { AdapterModel, ConnectionWhere } from "@/types/adapter-model";
import type { CallBinding, ProxyOperation } from "./call-processor";
import type { ResourceManager } from "./resource-manager";
import {
  RELEASE_PROXY_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "@/types/symbols";
import { Logger } from "@/logger";
import { NexusResourceError } from "@/errors/resource-errors";
import type { Engine } from "./engine";

type RemoteResource = {
  resourceId: string;
  connectionId: string;
  released: boolean;
  release(): void;
};
type ProxyPath = {
  binding: CallBinding;
  path: (string | number)[];
  root: boolean;
  resource?: RemoteResource;
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

/**
 * Creates path-based RPC facades with shared traps.
 * Service proxies carry only a binding and path; resource proxies also share one
 * release state. Weak metadata never keeps an otherwise unused facade alive.
 */
export class ProxyFactory implements ProxyHandler<ProxyTarget> {
  private readonly paths = new WeakMap<object, ProxyPath>();
  private readonly releaseRegistry: FinalizationRegistry<
    Pick<RemoteResource, "resourceId" | "connectionId">
  >;
  private readonly logger = new Logger("L3 -> ProxyFactory");

  constructor(
    private readonly engine: Pick<
      Engine<AdapterModel>,
      "safeDispatchCall" | "dispatchRelease"
    >,
    private readonly resourceManager: ResourceManager,
  ) {
    this.releaseRegistry = new FinalizationRegistry(
      ({ resourceId, connectionId }) => {
        this.resourceManager.releaseRemoteProxy(resourceId, connectionId);
        this.engine.dispatchRelease(resourceId, connectionId);
      },
    );
  }

  /** Captures the session snapshot; Engine installs lifecycle observation on unicast roots. */
  public createServiceProxy<
    T extends object,
    M extends AdapterModel = AdapterModel,
  >(serviceName: string, options: CreateProxyOptions<M>): T {
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
    return this.createProxy({ binding, path: [serviceName], root: true }) as T;
  }

  /**
   * Revives one capability. Every child path retains the same release state/finalizer anchor.
   * Explicit release is idempotent; local resource IDs never determine remote ownership.
   */
  public createRemoteResourceProxy(
    resourceId: string,
    connectionId: string,
  ): object {
    const resource: RemoteResource = {
      resourceId,
      connectionId,
      released: false,
      release: () => {
        if (resource.released) return;
        resource.released = true;
        this.releaseRegistry.unregister(resource);
        this.resourceManager.releaseRemoteProxy(resourceId, connectionId);
        this.engine.dispatchRelease(resourceId, connectionId);
      },
    };
    // Held values contain only IDs, never the resource state or a facade.
    this.releaseRegistry.register(
      resource,
      { resourceId, connectionId },
      resource,
    );
    this.resourceManager.registerRemoteProxy(resourceId, connectionId);
    return this.createProxy({
      binding: { target: { connectionId }, strategy: "one", timeout: 5000 },
      path: [],
      root: true,
      resource,
    });
  }

  /** Drops this facade's finalizer, leaving a pre-existing shared resource identity intact. */
  public discardRemoteResourceProxy(proxy: object): void {
    const resource = this.paths.get(proxy)?.resource;
    if (resource) this.releaseRegistry.unregister(resource);
  }

  // ===== Paths: property access extends a path; await/call/set dispatch it =====

  /** Roots are not thenable; awaiting a child path dispatches GET. Symbols remain local. */
  public get(
    target: ProxyTarget,
    prop: string | symbol,
    receiver: unknown,
  ): any {
    const state = this.paths.get(target)!;
    if (prop === "then") {
      if (state.root) return undefined;
      const result = this.dispatch(state, { type: "GET", path: state.path });
      return result.then.bind(result);
    }
    if (prop === RELEASE_PROXY_SYMBOL)
      return state.resource?.release ?? releaseServiceProxy;
    if (prop === Symbol.dispose && state.resource)
      return state.resource.release;
    if (isLifecycleSymbol(prop)) return Reflect.get(target, prop);
    if (typeof prop === "symbol" || INTERNAL_PROXY_PROPERTIES.has(prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return this.createProxy({
      ...state,
      path: [...state.path, prop],
      root: false,
    });
  }

  /** Returns the call Promise unchanged by logging policy; the caller owns its rejection. */
  public apply(
    target: ProxyTarget,
    _thisArg: unknown,
    args: any[],
  ): Promise<any> {
    const state = this.paths.get(target)!;
    return this.dispatch(state, { type: "APPLY", path: state.path, args });
  }

  public set(target: ProxyTarget, prop: string | symbol, value: any): boolean {
    if (isLifecycleSymbol(prop)) {
      Reflect.set(target, prop, value);
      return true;
    }
    const state = this.paths.get(target)!;
    if (!state.resource) return false;
    // SET cannot return a Promise: released resources must throw from the trap itself.
    this.assertActive(state.resource);
    // Assignment cannot expose a completion Promise, so this is framework-owned work.
    void this.dispatch(state, {
      type: "SET",
      path: [...state.path, prop as string],
      value,
    }).catch((error) =>
      this.logger.error("Remote property assignment failed", error),
    );
    return true;
  }

  private createProxy(state: ProxyPath): any {
    const target = () => {};
    const proxy = new Proxy(target, this);
    // Traps receive the target; discard receives the facade. Both use one weak index.
    this.paths.set(target, state);
    this.paths.set(proxy, state);
    return proxy;
  }

  /**
   * The sole Result-to-rejection boundary for proxy operations.
   * Internal dispatch owns error normalization; GET/APPLY callers own the Promise,
   * while the SET trap observes its otherwise inaccessible rejection.
   */
  private async dispatch(
    state: ProxyPath,
    operation: ProxyOperation,
  ): Promise<any> {
    this.assertActive(state.resource);
    const result = await this.engine.safeDispatchCall({
      ...state.binding,
      resourceId: state.resource?.resourceId ?? null,
      ...operation,
    });
    if (result.isErr()) throw result.error;
    return result.value;
  }

  private assertActive(resource?: RemoteResource): void {
    if (resource?.released)
      throw new NexusResourceError(
        `Remote resource proxy "${resource.resourceId}" has been released and is no longer usable.`,
        "E_RESOURCE_ACCESS_DENIED",
        {
          resourceId: resource.resourceId,
          connectionId: resource.connectionId,
        },
      );
  }
}

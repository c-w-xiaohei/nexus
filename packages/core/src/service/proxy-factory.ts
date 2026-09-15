import type { CallBinding, DispatchCallOptions } from "./call-processor";
import type { ResourceManager } from "./resource-manager";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { NexusResourceError } from "@/errors/resource-errors";
import type { Connection } from "@/api/connection";
import {
  NexusUsageError,
  toFrameworkProtocolError,
  type NexusCallError,
} from "@/errors";
import type { AdapterModel } from "@/types/adapter-model";
import type { RemoteValue } from "@/api/types";
import { Result } from "better-result";

const consumers = new WeakMap<
  object,
  () => Promise<Result<any, NexusCallError>>
>();

/** Consumes only a proxy-created operation, sharing its cached execution with await. */
export function safeCall<T, M extends AdapterModel>(
  value: RemoteValue<T, M>,
): Promise<Result<T, NexusCallError>> {
  const consume = consumers.get(value);
  if (!consume)
    throw new NexusUsageError("safeCall requires one Nexus lazy remote call.");
  return consume();
}

type RemoteResource = {
  resourceId: string;
  released: boolean;
  /** Releases this shared capability once, including its finalizer registration. */
  release(): void;
};
type ProxyPath = {
  binding: CallBinding;
  path: (string | number)[];
  resource?: RemoteResource;
  connection: Connection<any>;
};

const INTERNAL_PROXY_PROPERTIES = new Set([
  "constructor",
  "inspect",
  "valueOf",
  "toString",
  "nodeType",
]);
/** Keep release calls on service roots harmless while reserving release for resources. */
const releaseServiceProxy = () =>
  console.warn(
    "Nexus: A service proxy cannot be released. This function is for resource proxies only.",
  );

/**
 * Creates path-based RPC facades whose closures retain their binding and path.
 * Service proxies carry only a binding and path; resource proxies also share one
 * release state. Weak metadata never keeps an otherwise unused facade alive.
 */
export class ProxyFactory {
  private readonly resourceAnchors = new WeakMap<object, RemoteResource>();
  private readonly releaseRegistry: FinalizationRegistry<{
    resourceId: string;
    connectionId: string;
  }>;

  /** Own dispatch, resource bookkeeping, connection lookup, and finalization policy. */
  constructor(
    private readonly engine: {
      safeDispatchCall(
        options: DispatchCallOptions,
      ): Promise<Result<any, NexusCallError>>;
      dispatchRelease(resourceId: string, connectionId: string): void;
    },
    private readonly resourceManager: ResourceManager,
    private readonly getConnection: (id: string) => Connection<any>,
    private readonly callTimeout = 5_000,
  ) {
    this.releaseRegistry = new FinalizationRegistry(
      ({ resourceId, connectionId }) => {
        this.resourceManager.releaseRemoteProxy(resourceId, connectionId);
        this.engine.dispatchRelease(resourceId, connectionId);
      },
    );
  }

  /** Captures a session-bound call budget and source without installing per-proxy lifecycle observers. */
  public createServiceProxy<T extends object>(
    serviceName: string,
    options: CallBinding,
  ): T {
    const binding: CallBinding = {
      connectionId: options.connectionId,
      timeout: options.timeout,
    };
    return this.createProxy(
      {
        binding,
        path: [serviceName],
        connection: this.getConnection(binding.connectionId),
      },
      true,
    ) as T;
  }

  /**
   * Revives one capability. Every child path retains the same release state/finalizer anchor.
   * Explicit release is idempotent; local resource IDs never determine remote ownership.
   */
  public createRemoteResourceProxy(
    resourceId: string,
    connectionId: string,
    timeout = this.callTimeout,
  ): object {
    const connection = this.getConnection(connectionId);
    const resource: RemoteResource = {
      resourceId,
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
    const proxy = this.createProxy(
      {
        binding: { connectionId, timeout },
        path: [],
        resource,
        connection,
      },
      true,
    );
    this.resourceAnchors.set(proxy, resource);
    return proxy;
  }

  /** Drops this facade's finalizer, leaving a pre-existing shared resource identity intact. */
  public discardRemoteResourceProxy(proxy: object): void {
    const resource = this.resourceAnchors.get(proxy);
    if (resource) this.releaseRegistry.unregister(resource);
  }

  // ===== Paths and lazy operations =====

  /** Roots are not thenable; child reads and method calls execute only on consumption. */
  private createProxy(state: ProxyPath, root = false): object {
    const proxy = new Proxy(() => {}, {
      get: (target, prop, receiver) => {
        if (prop === "then" && root) return undefined;
        if (!root) {
          if (prop === "connection") return state.connection;
          if (prop === "then" || prop === "catch" || prop === "finally")
            return read![prop];
        }
        if (prop === RELEASE_PROXY_SYMBOL)
          return state.resource?.release ?? releaseServiceProxy;
        if (prop === Symbol.dispose && state.resource)
          return state.resource.release;
        if (typeof prop === "symbol" || INTERNAL_PROXY_PROPERTIES.has(prop))
          return Reflect.get(target, prop, receiver);
        return this.createProxy({ ...state, path: [...state.path, prop] });
      },
      apply: (_target, _receiver, args) => this.createCall(state, args),
      set: () => false,
    });
    const read = root ? undefined : this.createCall(state, undefined, proxy);
    return proxy;
  }

  /** Released references fail on consumption, just like disconnected sessions. */
  private createCall(
    state: ProxyPath,
    args?: any[],
    facade?: object,
  ): RemoteValue<any> {
    const id = state.binding.connectionId;
    let result: Promise<Result<any, NexusCallError>> | undefined;
    let promise: Promise<any> | undefined;
    /** Starts execution once and caches its safe outcome across all consumers. */
    const consume = () => {
      if (result) {
        return result;
      }
      result = Promise.resolve()
        .then(() => {
          if (state.resource?.released) {
            return Result.err(
              new NexusResourceError(
                `Remote resource "${state.resource.resourceId}" has been released.`,
                "E_RESOURCE_ACCESS_DENIED",
                { resourceId: state.resource.resourceId, connectionId: id },
              ),
            );
          }
          return this.engine.safeDispatchCall({
            ...state.binding,
            resourceId: state.resource?.resourceId ?? null,
            path: state.path,
            ...(args === undefined ? { type: "GET" } : { type: "APPLY", args }),
          });
        })
        .catch((error) => Result.err(toFrameworkProtocolError(error)));
      return result;
    };
    /** Shares one throw-style Promise without changing the cached safe outcome. */
    const unwrap = () => {
      if (!promise) {
        promise = consume().then((value) => {
          if (value.isErr()) {
            throw value.error;
          }
          return value.value;
        });
      }
      return promise;
    };
    const call: RemoteValue<any> = {
      connection: state.connection,
      then: (fulfilled, rejected) => unwrap().then(fulfilled, rejected),
      catch: (rejected) => unwrap().catch(rejected),
      finally: (callback) => unwrap().finally(callback),
    };
    consumers.set(facade ?? call, consume);
    return Object.freeze(call);
  }
}

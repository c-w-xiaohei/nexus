import type { CallBinding, DispatchCallOptions } from "./call-processor";
import type {
  ResourceManager,
  RemoteResourceIdentity,
} from "./resource-manager";
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
import type { ResourceScope } from "./resource-scope";

const consumers = new WeakMap<
  object,
  () => Promise<Result<any, NexusCallError>>
>();
const proxyBindings = new WeakMap<object, CallBinding>();

/** Internal identity inspection without invoking a user-controlled proxy getter. */
export const remoteBinding = (value: object): CallBinding | undefined =>
  proxyBindings.get(value);

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
  identity: RemoteResourceIdentity;
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
  private readonly releaseRegistry: FinalizationRegistry<{
    resourceId: string;
    connectionId: string;
    scope?: ResourceScope;
    identity: RemoteResourceIdentity;
  }>;

  /** Own dispatch, resource bookkeeping, connection lookup, and finalization policy. */
  constructor(
    private readonly engine: {
      safeDispatchCall(
        options: DispatchCallOptions,
      ): Promise<Result<any, NexusCallError>>;
      dispatchRelease(
        resourceId: string,
        connectionId: string,
        scope?: ResourceScope,
      ): void;
    },
    private readonly resourceManager: ResourceManager,
    private readonly getConnection: (id: string) => Connection<any>,
    private readonly callTimeout = 5_000,
  ) {
    this.releaseRegistry = new FinalizationRegistry(
      ({ resourceId, connectionId, scope, identity }) => {
        if (identity.released || identity.anchor?.deref()) return;
        this.resourceManager.releaseRemoteProxy(
          resourceId,
          connectionId,
          scope,
        );
        this.engine.dispatchRelease(resourceId, connectionId, scope);
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
      transfer: options.transfer,
      ...(options.scope ? { scope: options.scope } : {}),
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
    scope?: ResourceScope,
    transfer?: boolean,
  ): object {
    const connection = this.getConnection(connectionId);
    const identity = this.resourceManager.registerRemoteProxy(
      resourceId,
      connectionId,
      scope,
    );
    let resource = identity.anchor?.deref() as RemoteResource | undefined;
    if (!resource) {
      resource = {
        resourceId,
        identity,
        release: () => {
          if (identity.released) return;
          this.releaseRegistry.unregister(resource!);
          this.resourceManager.releaseRemoteProxy(
            resourceId,
            connectionId,
            scope,
          );
          this.engine.dispatchRelease(resourceId, connectionId, scope);
        },
      };
      // Held identity metadata refers to its anchor weakly, never to a facade.
      this.releaseRegistry.register(
        resource,
        { resourceId, connectionId, scope, identity },
        resource,
      );
      identity.anchor = new WeakRef(resource);
    }
    return this.createProxy(
      {
        binding: { connectionId, timeout, scope, transfer },
        path: [],
        resource,
        connection,
      },
      true,
    );
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
    proxyBindings.set(proxy, state.binding);
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
          // A terminal scope is diagnosed by dispatch, which also preserves
          // physical disconnect precedence over domain closure.
          if (
            state.resource?.identity.released &&
            !state.binding.scope?.closed
          ) {
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

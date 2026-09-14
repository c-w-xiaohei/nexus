import type { Connection } from "@/api/connection";
import type { AdapterModel } from "@/types/adapter-model";
import {
  NexusDisconnectedError,
  NexusRemoteError,
  NexusResourceError,
  toFrameworkProtocolError,
} from "@/errors";
import type { Remote } from "@/api/types";
import { isRefWrapper } from "@/types/ref-wrapper";
import { PayloadProcessor } from "../service/payload/payload-processor";
import { ProxyFactory } from "../service/proxy-factory";
import { ResourceManager } from "../service/resource-manager";
import { PendingCallManager } from "../service/pending-call-manager";
import { installProxyLifecycle } from "../service/proxy-lifecycle";
import { Result } from "better-result";
import { toSerializedError } from "../utils/error";

/** @internal Reuses Core's resource and proxy paths for @nexus-js/testing. */
export const createInMemoryServiceProxy = <
  T extends object,
  M extends AdapterModel,
>(
  implementation: T,
  connection: Connection<M>,
  callTimeout = 5_000,
  tokenId = "",
): Remote<T, M> => {
  const resources = new ResourceManager();
  const pending = new PendingCallManager();
  let sequence = 0;
  const proxyFactory = new ProxyFactory(
    {
      safeDispatchCall: (options) => {
        if (connection.status === "disconnected")
          return Promise.resolve(
            Result.err(
              new NexusDisconnectedError(
                "The session is disconnected.",
                "E_CONN_CLOSED",
                { connectionId: connection.id },
              ),
            ),
          );
        const id = ++sequence;
        const result = pending.register(id, {
          connectionId: connection.id,
          timeout: options.timeout,
        });
        void (async () => {
          const root =
            options.resourceId === null
              ? implementation
              : resources.getLocalResource(options.resourceId)?.target;
          if (!root)
            return Result.err(
              new NexusResourceError(
                "Remote resource is no longer available.",
                "E_RESOURCE_NOT_FOUND",
                { resourceId: options.resourceId, connectionId: connection.id },
              ),
            );
          let result: unknown;
          try {
            let value: any = root;
            let owner: any;
            for (const key of options.path.slice(
              options.resourceId === null ? 1 : 0,
            )) {
              owner = value;
              value = value[key];
            }
            // Match Core's APPLY boundary: settle business execution before encoding
            // its result. GET retains Promise-valued properties as capabilities.
            result =
              options.type === "GET"
                ? value
                : await Reflect.apply(
                    value,
                    owner,
                    unwrapInMemoryRefs(options.args) as unknown[],
                  );
          } catch (error) {
            return Result.err(
              new NexusRemoteError(
                "Remote service threw an exception.",
                "E_REMOTE_EXCEPTION",
                { remoteError: toSerializedError(error) },
              ),
            );
          }
          // A late result must not create capabilities after timeout/disconnect.
          if (!pending.canHandleResponse(id, connection.id))
            return Result.ok(undefined);
          return payloads
            .safeSanitize([result], connection.id)
            .andThen((encoded) =>
              payloads.safeRevive(encoded, connection.id, options.timeout),
            )
            .map(([revived]) => revived)
            .mapError(toFrameworkProtocolError);
        })().then(
          (outcome) => {
            if (outcome.isErr()) pending.fail(id, outcome.error);
            else pending.handleResponse(id, outcome.value, null, connection.id);
          },
          (error) => pending.fail(id, toFrameworkProtocolError(error)),
        );
        return result;
      },
      dispatchRelease: (resourceId) =>
        resources.releaseLocalResource(resourceId),
    },
    resources,
    () => connection,
  );
  connection.onDisconnected(() => {
    pending.onDisconnect(connection.id);
    resources.cleanupConnection(connection.id);
  });
  const payloads = new PayloadProcessor(resources, proxyFactory);
  const proxy = proxyFactory.createServiceProxy<Remote<T, M>>(tokenId, {
    connectionId: connection.id,
    timeout: callTimeout,
  });
  installProxyLifecycle(proxy, tokenId, connection.id, {
    subscribeDisconnect: (listener) => connection.onDisconnected(listener),
    subscribeStale: () => () => {},
  });
  return proxy;
};

/** @internal Direct mocks share memory, so argument refs revive to their targets. */
const unwrapInMemoryRefs = (value: unknown): unknown => {
  const seen = new WeakMap<object, unknown>();
  const unwrap = (item: unknown): unknown => {
    if (isRefWrapper(item)) return item.target;
    if (Array.isArray(item)) {
      const existing = seen.get(item);
      if (existing) return existing;
      const revived: unknown[] = [];
      seen.set(item, revived);
      for (const value of item) revived.push(unwrap(value));
      return revived;
    }
    if (!isPlainRecord(item)) return item;
    const existing = seen.get(item);
    if (existing) return existing;
    const revived: Record<string, unknown> = Object.create(
      Object.getPrototypeOf(item),
    );
    seen.set(item, revived);
    for (const [key, value] of Object.entries(item))
      revived[key] = unwrap(value);
    return revived;
  };
  return unwrap(value);
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

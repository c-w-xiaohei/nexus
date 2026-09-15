import type { Connection } from "@/api/connection";
import type { AdapterModel } from "@/types/adapter-model";
import { toFrameworkProtocolError } from "@/errors";
import type { Remote } from "@/api/types";
import { isRefWrapper } from "@/types/ref-wrapper";
import { PayloadProcessor } from "../service/payload/payload-processor";
import { ProxyFactory } from "../service/proxy-factory";
import { ResourceManager } from "../service/resource-manager";
import { PendingCallManager } from "../service/pending-call-manager";
import { Result } from "better-result";
import { CallProcessor } from "../service/call-processor";
import { MessageHandler } from "../service/message/message-handler";

export {
  safeConnect as safeAcquireConnection,
  safeConnectMulticast as safeAcquireConnections,
  type AcquisitionSession,
  type AcquisitionSource,
} from "../api/acquire";

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
  resources.registerExposedServices([
    { name: tokenId, service: implementation },
  ]);
  const proxyFactory = new ProxyFactory(
    {
      safeDispatchCall: (options) => calls.safeProcess(options),
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
  const replies = new MessageHandler({
    resourceManager: resources,
    pendingCalls: pending,
    payloadProcessor: payloads,
    safeSendMessage: () => Result.ok(undefined),
    dispatchRelease: (id) => resources.releaseLocalResource(id),
  });
  const requests = new MessageHandler({
    resourceManager: resources,
    pendingCalls: pending,
    // Only arguments share memory. Replies use the normal codec so returned
    // resources retain production ownership, timeout and orphan cleanup rules.
    payloadProcessor: {
      safeRevive: (args) =>
        Result.try({
          try: () => unwrapInMemoryRefs(args) as any[],
          catch: toFrameworkProtocolError,
        }),
      safeSanitizeFromService: (...args) =>
        payloads.safeSanitizeFromService(...args),
      releaseSanitizedResources: (value) =>
        payloads.releaseSanitizedResources(value),
      releaseOrphanedResponseResources: (...args) =>
        payloads.releaseOrphanedResponseResources(...args),
    },
    safeSendMessage: (message, source) => {
      void replies.safeHandleMessage(message, source);
      return Result.ok(undefined);
    },
    dispatchRelease: (id) => resources.releaseLocalResource(id),
    getConnectionAuthContext: () => ({
      localIdentity: connection.contextMeta,
      remoteIdentity: connection.contextMeta,
      connection: connection.connectionMeta,
    }),
  });
  const calls = new CallProcessor({
    isConnectionReady: () => connection.status === "connected",
    pendingCallManager: pending,
    payloadProcessor: {
      safeSanitize: (args) => Result.ok(args),
      // Shared-memory arguments allocate no outgoing capabilities.
      releaseSanitizedResources: () => {},
    },
    sendMessage: (message, source) => {
      void requests.safeHandleMessage(message, source).then((result) => {
        if (result.isErr() && message.id !== null)
          pending.fail(message.id, result.error);
      });
      return Result.ok(undefined);
    },
  });
  return proxyFactory.createServiceProxy<Remote<T, M>>(tokenId, {
    connectionId: connection.id,
    timeout: callTimeout,
  });
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

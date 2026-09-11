import { Nexus } from "@nexus-js/core";
import { createNexusStore } from "@nexus-js/core/state";
import { usingIframeParent, type IframeAdapterModel } from "@nexus-js/iframe";
import {
  APP_ID,
  CHILD_ORIGIN,
  FRAME_IDS,
  iframeCounterStore,
  createCounterStoreCreator,
  frameNonce,
  type CounterStore,
  type FrameId,
} from "./shared";

type StoreImplementation = typeof provider.service;

type StoreImplementationWithDisconnectHook = StoreImplementation & {
  [SERVICE_INVOKE_START]?(
    context: SubscribeInvocationContext,
  ): SubscribeInvocationContext;
  [SERVICE_INVOKE_END]?(invocation?: SubscribeInvocationContext): void;
  [SERVICE_ON_DISCONNECT]?(connectionId: string): void;
};

const SERVICE_ON_DISCONNECT = Symbol.for("nexus.service.on.disconnect");
const SERVICE_INVOKE_START = Symbol.for("nexus.service.invoke.start");
const SERVICE_INVOKE_END = Symbol.for("nexus.service.invoke.end");

interface SubscribeInvocationContext {
  readonly sourceConnectionId: string;
}

interface OwnerAwareStoreImplementation extends StoreImplementation {
  subscribe(
    onSync: Parameters<StoreImplementation["subscribe"]>[0],
    invocation?: SubscribeInvocationContext,
  ): ReturnType<StoreImplementation["subscribe"]>;
}

const telemetry = {
  readyFrames: [] as string[],
  subscribeCalls: 0,
  unsubscribeCalls: 0,
  dispatchCalls: [] as Array<{ action: string; args: unknown[] }>,
  snapshots: [] as Array<{ version: number; count: number; writes: number }>,
  activeSubscriptions: new Map<symbol, string | undefined>(),
};

function getFrame(frameId: string) {
  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe[data-frame-id="${frameId}"]`,
  );
  if (!iframe) throw new Error(`Missing child iframe ${frameId}`);
  return iframe;
}

function instrumentStore(
  implementation: StoreImplementation,
): StoreImplementation {
  const implementationWithHooks =
    implementation as StoreImplementationWithDisconnectHook;
  const ownerAwareImplementation =
    implementation as OwnerAwareStoreImplementation;
  const wrapper = Object.create(
    Object.getPrototypeOf(implementation),
  ) as StoreImplementationWithDisconnectHook;
  Object.defineProperties(
    wrapper,
    Object.getOwnPropertyDescriptors(implementation),
  );

  wrapper.subscribe = async (onSync, ...args) => {
    telemetry.subscribeCalls += 1;
    const key = Symbol("subscription");
    const [invocation] = args as [SubscribeInvocationContext?];
    return ownerAwareImplementation.subscribe(
      async (event) => {
        if (event.type === "init") {
          telemetry.activeSubscriptions.set(
            key,
            invocation?.sourceConnectionId,
          );
          const originalUnsubscribe = event.unsubscribe;
          const actions = Object.fromEntries(
            Object.entries(event.actions).map(([action, invoke]) => [
              action,
              async (...invokeArgs: unknown[]) => {
                telemetry.dispatchCalls.push({
                  action,
                  args: [...invokeArgs],
                });
                return (invoke as (...args: unknown[]) => unknown)(
                  ...invokeArgs,
                );
              },
            ]),
          ) as typeof event.actions;
          event = {
            ...event,
            actions,
            unsubscribe: async () => {
              telemetry.unsubscribeCalls += 1;
              telemetry.activeSubscriptions.delete(key);
              return originalUnsubscribe();
            },
          };
        }
        if (event.type === "terminal") {
          telemetry.activeSubscriptions.delete(key);
        }
        if (event.type === "snapshot" || event.type === "init") {
          telemetry.snapshots.push({
            version: event.version,
            count: event.state.count,
            writes: event.state.writes.length,
          });
        }
        return onSync(event);
      },
      ...(args as [SubscribeInvocationContext?]),
    );
  };

  wrapper[SERVICE_INVOKE_START] = (context) => {
    return implementationWithHooks[SERVICE_INVOKE_START]?.(context) ?? context;
  };

  wrapper[SERVICE_INVOKE_END] = (invocation) => {
    implementationWithHooks[SERVICE_INVOKE_END]?.(invocation);
  };

  wrapper[SERVICE_ON_DISCONNECT] = (connectionId) => {
    implementationWithHooks[SERVICE_ON_DISCONNECT]?.(connectionId);
    for (const [key, owner] of telemetry.activeSubscriptions)
      if (owner === connectionId) telemetry.activeSubscriptions.delete(key);
  };

  return wrapper;
}

const { provider } = createNexusStore(
  iframeCounterStore,
  createCounterStoreCreator(),
  {
    snapshot: (state: CounterStore) => ({
      count: state.count,
      writes: state.writes,
    }),
    expose: [
      "increment",
      "setCount",
      "asyncIncrementSlow",
      "failAfterNoCommit",
    ],
  },
);
const host = new Nexus<IframeAdapterModel>().configure({
  ...usingIframeParent({
    configure: false,
    appId: APP_ID,
    frames: FRAME_IDS.map((frameId) => ({
      frameId,
      iframe: getFrame(frameId),
      origin: CHILD_ORIGIN,
      nonce: frameNonce(frameId),
    })),
    heartbeat: { intervalMs: 100, maxMisses: 2 },
  }),
  providers: [
    {
      token: provider.token,
      service: instrumentStore(provider.service),
    },
  ],
});

window.addEventListener("message", (event) => {
  const data = event.data as { type?: string; frameId?: string } | undefined;
  if (data?.type !== "react-state-child-ready" || !data.frameId) return;
  if (!telemetry.readyFrames.includes(data.frameId)) {
    telemetry.readyFrames.push(data.frameId);
  }
});

for (const frameId of FRAME_IDS) {
  const iframe = getFrame(frameId);
  iframe.src = iframe.dataset.src ?? "";
}

function getHostTelemetry() {
  return {
    readyFrames: [...telemetry.readyFrames],
    subscribeCalls: telemetry.subscribeCalls,
    unsubscribeCalls: telemetry.unsubscribeCalls,
    activeSubscriptions: telemetry.activeSubscriptions.size,
    dispatchCalls: [...telemetry.dispatchCalls],
    snapshots: [...telemetry.snapshots],
  };
}

async function reloadFrame(frameId: FrameId, reconnect = true) {
  telemetry.readyFrames = telemetry.readyFrames.filter((id) => id !== frameId);
  const iframe = getFrame(frameId);
  const loaded = new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
  });
  if (!reconnect) {
    iframe.src = "about:blank";
    await loaded;
    return;
  }
  iframe.src = `${CHILD_ORIGIN}/child.html?frameId=${frameId}&reload=${Date.now()}`;
  await loaded;
}

async function reconnectFrame(frameId: FrameId) {
  telemetry.readyFrames = telemetry.readyFrames.filter((id) => id !== frameId);
  const iframe = getFrame(frameId);
  const loaded = new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
  });
  iframe.src = `${CHILD_ORIGIN}/child.html?frameId=${frameId}&reload=${Date.now()}`;
  await loaded;
}

async function removeFrame(frameId: FrameId) {
  telemetry.readyFrames = telemetry.readyFrames.filter((id) => id !== frameId);
  getFrame(frameId).remove();
}

async function postSpoofedConnect(nonce: string) {
  window.postMessage(
    {
      __nexusIframe: true,
      appId: APP_ID,
      channel: "nexus:iframe",
      nonce,
      payload: {
        __nexusVirtualPort: true,
        version: 1,
        type: "connect",
        channelId: "attacker-channel",
        from: "attacker",
        nonce: "attacker-nonce",
      },
    },
    "http://127.0.0.1:3310",
  );
}

Object.assign(window, {
  getHostTelemetry,
  reloadFrame,
  reconnectFrame,
  removeFrame,
  postSpoofedConnect,
  hostNexus: host,
});

document.getElementById("host-status")!.textContent = "ready";

import { Nexus } from "@nexus-js/core";
import {
  provideNexusStore,
  type NexusStoreServiceContract,
} from "@nexus-js/core/state";
import { usingIframeParent } from "@nexus-js/iframe";
import {
  APP_ID,
  CHILD_ORIGIN,
  FRAME_IDS,
  counterStore,
  frameNonce,
  type CounterActions,
  type CounterState,
  type FrameId,
} from "./shared";

type StoreImplementation = NexusStoreServiceContract<
  CounterState,
  CounterActions
>;

type StoreImplementationWithDisconnectHook = StoreImplementation & {
  [SERVICE_INVOKE_START]?(connectionId: string): SubscribeInvocationContext;
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
  subscriptionIds: new Set<string>(),
  subscriptionOwners: new Map<string, string>(),
  subscriptionsByFrame: new Map<string, Set<string>>(),
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
    const result = await ownerAwareImplementation.subscribe(
      (event) => {
        if (event.type !== "snapshot") {
          onSync(event);
          return;
        }

        telemetry.snapshots.push({
          version: event.version,
          count: event.state.count,
          writes: event.state.writes.length,
        });
        onSync(event);
      },
      ...args,
    );
    telemetry.subscriptionIds.add(result.subscriptionId);
    const [invocation] = args as [SubscribeInvocationContext?];
    const ownerConnectionId = invocation?.sourceConnectionId;
    if (ownerConnectionId) {
      telemetry.subscriptionOwners.set(
        result.subscriptionId,
        ownerConnectionId,
      );
    }
    const frameId = eventFrameId(invocation, telemetry.subscribeCalls);
    if (frameId) {
      const frameSubscriptions =
        telemetry.subscriptionsByFrame.get(frameId) ?? new Set<string>();
      frameSubscriptions.add(result.subscriptionId);
      telemetry.subscriptionsByFrame.set(frameId, frameSubscriptions);
    }
    telemetry.snapshots.push({
      version: result.version,
      count: result.state.count,
      writes: result.state.writes.length,
    });
    return result;
  };

  wrapper.unsubscribe = async (subscriptionId) => {
    telemetry.unsubscribeCalls += 1;
    telemetry.subscriptionIds.delete(subscriptionId);
    telemetry.subscriptionOwners.delete(subscriptionId);
    for (const subscriptions of telemetry.subscriptionsByFrame.values()) {
      subscriptions.delete(subscriptionId);
    }
    return implementation.unsubscribe(subscriptionId);
  };

  wrapper.dispatch = async (action, args) => {
    telemetry.dispatchCalls.push({ action, args: [...args] });
    return implementation.dispatch(action, args);
  };

  wrapper[SERVICE_INVOKE_START] = (connectionId) => {
    return (
      implementationWithHooks[SERVICE_INVOKE_START]?.(connectionId) ??
      ({
        sourceConnectionId: connectionId,
      } as unknown as SubscribeInvocationContext)
    );
  };

  wrapper[SERVICE_INVOKE_END] = (invocation) => {
    implementationWithHooks[SERVICE_INVOKE_END]?.(invocation);
  };

  wrapper[SERVICE_ON_DISCONNECT] = (connectionId) => {
    implementationWithHooks[SERVICE_ON_DISCONNECT]?.(connectionId);
    for (const [
      subscriptionId,
      ownerConnectionId,
    ] of telemetry.subscriptionOwners) {
      if (ownerConnectionId !== connectionId) continue;
      telemetry.subscriptionIds.delete(subscriptionId);
      telemetry.subscriptionOwners.delete(subscriptionId);
    }
  };

  return wrapper;
}

function eventFrameId(
  invocation: unknown,
  subscribeCallIndex: number,
): string | undefined {
  const connectionId = (invocation as SubscribeInvocationContext | undefined)
    ?.sourceConnectionId;
  if (connectionId) {
    // Connection IDs include the iframe adapter frame id in this browser harness.
    for (const frameId of FRAME_IDS) {
      if (connectionId.includes(frameId)) return frameId;
    }
  }

  return FRAME_IDS[(subscribeCallIndex - 1) % FRAME_IDS.length];
}

const registration = provideNexusStore(counterStore);
const host = new Nexus().configure({
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
  services: [
    {
      token: registration.token,
      implementation: instrumentStore(registration.implementation),
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
    activeSubscriptions: telemetry.subscriptionIds.size,
    subscriptionOwners: Array.from(telemetry.subscriptionOwners.entries()),
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

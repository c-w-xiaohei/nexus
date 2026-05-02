import { Nexus } from "@nexus-js/core";
import {
  NexusProvider,
  useRemoteStore,
  useStoreSelector,
} from "@nexus-js/react";
import { usingIframeChild } from "@nexus-js/iframe";
import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  APP_ID,
  HOST_ORIGIN,
  counterStore,
  frameNonce,
  type CounterState,
} from "./shared";

const frameId = new URLSearchParams(window.location.search).get("frameId");
if (!frameId) throw new Error("Missing frameId query parameter");

type BrowserEventListener = Parameters<typeof window.addEventListener>[1];
type BrowserAddOptions = Parameters<typeof window.addEventListener>[2];
type BrowserRemoveOptions = Parameters<typeof window.removeEventListener>[2];

const messageListeners: BrowserEventListener[] = [];
const addEventListener = window.addEventListener.bind(window);
const removeEventListener = window.removeEventListener.bind(window);
function trackedAddEventListener(
  this: Window,
  type: string,
  listener: BrowserEventListener | null,
  options?: BrowserAddOptions,
) {
  if (type === "message" && listener) messageListeners.push(listener);
  if (!listener) return;
  addEventListener(type, listener, options);
}
function trackedRemoveEventListener(
  this: Window,
  type: string,
  listener: BrowserEventListener | null,
  options?: BrowserRemoveOptions,
) {
  if (type === "message" && listener) {
    const index = messageListeners.indexOf(listener);
    if (index >= 0) messageListeners.splice(index, 1);
  }
  if (!listener) return;
  removeEventListener(type, listener, options);
}
window.addEventListener = trackedAddEventListener;
window.removeEventListener = trackedRemoveEventListener;

const hostTarget = {
  descriptor: { context: "iframe-parent", appId: APP_ID },
  matcher: (identity: { context?: string; appId?: string }) =>
    identity.context === "iframe-parent" && identity.appId === APP_ID,
} as const;

const child = new Nexus().configure({
  ...usingIframeChild({
    configure: false,
    appId: APP_ID,
    frameId,
    parentOrigin: HOST_ORIGIN,
    nonce: frameNonce(frameId),
    heartbeat: { intervalMs: 100, maxMisses: 2 },
    connectTo: [{ descriptor: hostTarget.descriptor }],
  }),
});

const telemetry = {
  commits: [] as CounterState[],
  statuses: [] as string[],
  errors: [] as string[],
  oldHandle: null as
    | null
    | ReturnType<typeof useRemoteStore<CounterState, any>>["store"],
};

let latestRemote: ReturnType<typeof useRemoteStore<CounterState, any>> | null =
  null;

function saveCurrentHandle() {
  telemetry.oldHandle = latestRemote?.store ?? null;
}

function CounterApp() {
  const remote = useRemoteStore(counterStore, { target: hostTarget });
  latestRemote = remote;
  const count = useStoreSelector(remote, (state) => state.count, {
    fallback: -1,
  });
  const writes = useStoreSelector(remote, (state) => state.writes.length, {
    fallback: -1,
  });

  useEffect(() => {
    telemetry.statuses.push(remote.status.type);
  }, [remote.status]);

  useEffect(() => {
    if (!remote.store || remote.status.type !== "ready") return;
    telemetry.commits.push(remote.store.getState());
  }, [remote.store, remote.status, count, writes]);

  return (
    <main>
      <div id="frame-id">{frameId}</div>
      <div id="status">{remote.status.type}</div>
      <div id="count">{count}</div>
      <div id="writes">{writes}</div>
      <div id="last-write">
        {remote.store?.getState().writes.at(-1)?.actor ?? "none"}
      </div>
    </main>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing root element");
const appRootElement = rootElement;

let root: Root | null = null;

function mount() {
  if (root) return;
  root = createRoot(appRootElement);
  root.render(
    <NexusProvider nexus={child}>
      <CounterApp />
    </NexusProvider>,
  );
}

function unmount() {
  if (!root) return;
  saveCurrentHandle();
  root.unmount();
  root = null;
}

function getStore() {
  if (!latestRemote?.store) throw new Error("Remote store is not ready");
  return latestRemote.store;
}

async function increment(by = 1) {
  const result = await getStore().actions.increment(frameId, by);
  return { result, state: getStore().getState() };
}

async function setCount(value: number) {
  const result = await getStore().actions.setCount(frameId, value);
  return { result, state: getStore().getState() };
}

async function asyncIncrementSlow(by: number, delayMs: number) {
  const result = await getStore().actions.asyncIncrementSlow(
    frameId,
    by,
    delayMs,
  );
  return { result, state: getStore().getState() };
}

async function failAfterNoCommit() {
  try {
    await getStore().actions.failAfterNoCommit(frameId);
    return { ok: true, message: "resolved", state: getStore().getState() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    telemetry.errors.push(message);
    return { ok: false, message, state: getStore().getState() };
  }
}

async function callOldHandleAfterDisconnect() {
  if (!telemetry.oldHandle) throw new Error("Missing old handle");
  try {
    await telemetry.oldHandle.actions.increment(`${frameId}:old`, 1);
    return "resolved";
  } catch {
    return "rejected";
  }
}

function makeUnresponsive() {
  saveCurrentHandle();
  for (const listener of [...messageListeners]) {
    window.removeEventListener("message", listener);
  }
}

function postForgedParentEnvelope(
  nonce: string,
  type: "connect" | "message" = "connect",
  overrides: {
    channel?: string;
    frameId?: string;
    payload?: Partial<{
      channelId: string;
      from: string;
      nonce: string;
      message: string;
    }>;
  } = {},
) {
  const payload = {
    __nexusVirtualPort: true,
    version: 1,
    type,
    channelId: `${frameId}:forged-channel`,
    from: frameId,
    nonce,
    ...(type === "message"
      ? { message: JSON.stringify([3, "forged", null, ["dispatch"], []]) }
      : {}),
    ...overrides.payload,
  };

  window.parent.postMessage(
    {
      __nexusIframe: true,
      appId: APP_ID,
      channel: overrides.channel ?? "nexus:iframe",
      frameId: overrides.frameId ?? frameId,
      nonce,
      payload,
    },
    HOST_ORIGIN,
  );
}

function getTelemetry() {
  return {
    commits: [...telemetry.commits],
    statuses: [...telemetry.statuses],
    errors: [...telemetry.errors],
    currentState: latestRemote?.store?.getState() ?? null,
    currentStatus: latestRemote?.status.type ?? "missing",
  };
}

Object.assign(window, {
  getTelemetry,
  increment,
  setCount,
  failAfterNoCommit,
  asyncIncrementSlow,
  unmount,
  remount: mount,
  callOldHandleAfterDisconnect,
  makeUnresponsive,
  postForgedParentEnvelope,
  childNexus: child,
});

mount();
window.parent.postMessage(
  { type: "react-state-child-ready", frameId },
  HOST_ORIGIN,
);

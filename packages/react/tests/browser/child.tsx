import { Nexus } from "@nexus-js/core";
import type { RemoteStore } from "@nexus-js/core/state";
import {
  createNexusScope,
  useStore,
  type UseRemoteStoreResult,
} from "@nexus-js/react";
import { usingIframeChild, type IframeAdapterModel } from "@nexus-js/iframe";
import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  APP_ID,
  HOST_ORIGIN,
  iframeCounterStore,
  frameNonce,
  type CounterActions,
  type CounterState,
} from "./shared";

const frameId = getRequiredFrameId();

function getRequiredFrameId() {
  const value = new URLSearchParams(window.location.search).get("frameId");
  if (!value) throw new Error("Missing frameId query parameter");
  return value;
}

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
  context: "iframe-parent",
  appId: APP_ID,
  origin: HOST_ORIGIN,
} as const;
const hostWhere = (identity: { context?: string; appId?: string }) =>
  identity.context === "iframe-parent" && identity.appId === APP_ID;

const childConfig = usingIframeChild({
  configure: false,
  appId: APP_ID,
  frameId,
  parentOrigin: HOST_ORIGIN,
  nonce: frameNonce(frameId),
  heartbeat: { intervalMs: 100, maxMisses: 2 },
});
const child = new Nexus<IframeAdapterModel>().configure({
  ...childConfig,
});

const telemetry = {
  commits: [] as CounterState[],
  statuses: [] as string[],
  errors: [] as string[],
  oldHandle: null as RemoteStore<CounterState, CounterActions> | null,
};

const IframeNexusScope = createNexusScope<IframeAdapterModel>();
let latestRemote: UseRemoteStoreResult<CounterState, CounterActions> | null =
  null;

function saveCurrentHandle() {
  telemetry.oldHandle = latestRemote?.store ?? null;
}

function CounterApp() {
  const remote = IframeNexusScope.useRemoteStore(iframeCounterStore, {
    target: hostTarget,
    where: hostWhere,
  });
  latestRemote = remote;

  useEffect(() => {
    telemetry.statuses.push(remote.status.type);
  }, [remote.status]);

  return (
    <main>
      <div id="frame-id">{frameId}</div>
      <div id="status">{remote.status.type}</div>
      {remote.store ? <StoreView store={remote.store} /> : <StoreFallback />}
    </main>
  );
}

function StoreView({
  store,
}: {
  store: RemoteStore<CounterState, CounterActions>;
}) {
  const snapshot = useStore(store);
  useEffect(() => {
    telemetry.commits.push(snapshot);
  }, [snapshot]);
  return (
    <>
      <div id="count">{snapshot.count}</div>
      <div id="writes">{snapshot.writes.length}</div>
      <div id="last-write">{snapshot.writes.at(-1)?.actor ?? "none"}</div>
    </>
  );
}

function StoreFallback() {
  return (
    <>
      <div id="count">-1</div>
      <div id="writes">-1</div>
      <div id="last-write">none</div>
    </>
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
    <IframeNexusScope.NexusProvider nexus={child}>
      <CounterApp />
    </IframeNexusScope.NexusProvider>,
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

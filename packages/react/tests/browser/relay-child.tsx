import { Nexus } from "@nexus-js/core";
import {
  createNexusScope,
  type UseRemoteStoreResult,
  useStoreStatus,
} from "@nexus-js/react";
import { useStore } from "zustand";
import type { RemoteStore } from "@nexus-js/core/state";
import { usingIframeChild, type IframeAdapterModel } from "@nexus-js/iframe";
import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RelayProfileToken,
  RELAY_APP_ID,
  RELAY_ORIGIN,
  iframeCounterStore,
  relayChildNonce,
  relayFrameTarget,
  type CounterStore,
  type RelayProfileService,
} from "./shared";

const childId = getRequiredChildId();

function getRequiredChildId() {
  const value = new URLSearchParams(window.location.search).get("childId");
  if (!value) throw new Error("Missing childId query parameter");
  return value;
}

const childConfig = usingIframeChild({
  configure: false,
  appId: RELAY_APP_ID,
  frameId: childId,
  parentOrigin: RELAY_ORIGIN,
  nonce: relayChildNonce(childId),
});
const childNexus = new Nexus<IframeAdapterModel>().configure({
  ...childConfig,
});

const telemetry = {
  statuses: [] as string[],
  errors: [] as string[],
  oldHandle: null as RemoteStore<CounterStore> | null,
};

const IframeNexusScope = createNexusScope<IframeAdapterModel>();
let latestRemote: UseRemoteStoreResult<CounterStore> | null = null;

function saveCurrentHandle() {
  telemetry.oldHandle = latestRemote?.store ?? null;
}

function RelayChildApp() {
  const remote = IframeNexusScope.useRemoteStore(iframeCounterStore, {
    target: relayFrameTarget,
  });
  const phase = useStoreStatus(remote.store, (status) => status.type);
  latestRemote = remote;

  useEffect(() => {
    telemetry.statuses.push(
      phase ?? (remote.error ? "failed" : "initializing"),
    );
  }, [phase, remote.error]);

  useEffect(() => {
    if (phase !== "ready") return;
    window.parent.postMessage(
      { type: "relay-child-ready", childId },
      RELAY_ORIGIN,
    );
  }, [phase]);

  return (
    <main>
      <div id="child-id">{childId}</div>
      <div id="status">
        {phase ?? (remote.error ? "failed" : "initializing")}
      </div>
      {remote.store ? <StoreView store={remote.store} /> : <StoreFallback />}
    </main>
  );
}

function StoreView({ store }: { store: RemoteStore<CounterStore> }) {
  const snapshot = useStore(store);
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
    <IframeNexusScope.NexusProvider nexus={childNexus}>
      <RelayChildApp />
    </IframeNexusScope.NexusProvider>,
  );
}

function getStore() {
  if (!latestRemote?.store) throw new Error("Remote store is not ready");
  return latestRemote.store;
}

async function readProfile() {
  const service = (await childNexus.create(RelayProfileToken, {
    target: relayFrameTarget,
  })) as unknown as RelayProfileService;
  return service.profile.read(childId);
}

async function increment(by = 1) {
  const result = await getStore().actions.increment(childId, by);
  return { result, state: getStore().getState() };
}

async function callOldHandleAfterDisconnect() {
  if (!telemetry.oldHandle) throw new Error("Missing old handle");
  try {
    await telemetry.oldHandle.actions.increment(`${childId}:old`, 1);
    return "resolved";
  } catch {
    return "rejected";
  }
}

function getRelayChildTelemetry() {
  return {
    statuses: [...telemetry.statuses],
    errors: [...telemetry.errors],
    currentStatus: latestRemote?.store?.getStatus().type ?? "missing",
    currentState: latestRemote?.store?.getState() ?? null,
  };
}

Object.assign(window, {
  getRelayChildTelemetry,
  readProfile,
  increment,
  saveCurrentHandle,
  callOldHandleAfterDisconnect,
  childNexus,
});

mount();

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
  RelayProfileToken,
  RELAY_APP_ID,
  RELAY_ORIGIN,
  counterStore,
  relayChildNonce,
  relayFrameTarget,
  type CounterState,
  type RelayProfileService,
} from "./shared";

const childId = getRequiredChildId();

function getRequiredChildId() {
  const value = new URLSearchParams(window.location.search).get("childId");
  if (!value) throw new Error("Missing childId query parameter");
  return value;
}

const childNexus = new Nexus().configure({
  ...usingIframeChild({
    configure: false,
    appId: RELAY_APP_ID,
    frameId: childId,
    parentOrigin: RELAY_ORIGIN,
    nonce: relayChildNonce(childId),
    heartbeat: { intervalMs: 100, maxMisses: 2 },
    connectTo: [{ descriptor: relayFrameTarget.descriptor }],
  }),
});

const telemetry = {
  statuses: [] as string[],
  errors: [] as string[],
  oldHandle: null as
    | ReturnType<typeof useRemoteStore<CounterState, any>>["store"]
    | null,
};

let latestRemote: ReturnType<typeof useRemoteStore<CounterState, any>> | null =
  null;

function saveCurrentHandle() {
  telemetry.oldHandle = latestRemote?.store ?? null;
}

function RelayChildApp() {
  const remote = useRemoteStore(counterStore, { target: relayFrameTarget });
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
    if (remote.status.type !== "ready") return;
    window.parent.postMessage(
      { type: "relay-child-ready", childId },
      RELAY_ORIGIN,
    );
  }, [remote.status]);

  return (
    <main>
      <div id="child-id">{childId}</div>
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
    <NexusProvider nexus={childNexus}>
      <RelayChildApp />
    </NexusProvider>,
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
    currentStatus: latestRemote?.status.type ?? "missing",
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

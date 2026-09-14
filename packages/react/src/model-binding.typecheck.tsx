import { Nexus, type AdapterModel, type ProxyStatus } from "@nexus-js/core";
import { createStoreToken, type RemoteStoreStatus } from "@nexus-js/core/state";
import { createNexusScope } from "./create-nexus-scope.js";
import { NexusProvider } from "./provider.js";
import { useNexus } from "./use-nexus.js";
import { useProxyStatus } from "./use-proxy-status.js";
import { useStore } from "zustand";
import type { UseRemoteStoreResult } from "./use-remote-store.js";
import { useStoreStatus } from "./use-store-status.js";

interface ChromeModel extends AdapterModel {
  contextMeta: { context: "chrome" };
  connectionMeta: { tabId: number };
  connectionTarget: { context: "chrome"; tabId: number };
}

interface IframeModel extends AdapterModel {
  contextMeta: { context: "iframe" };
  connectionMeta: { origin: string };
  connectionTarget: { context: "iframe"; origin: string };
}

interface CounterStore {
  count: number;
  increment(): void;
}

const chromeStore = createStoreToken<CounterStore, ChromeModel>(
  "state:react:model-binding:chrome",
);
const iframeStore = createStoreToken<CounterStore, IframeModel>(
  "state:react:model-binding:iframe",
);
void iframeStore;

const ChromeScope = createNexusScope<ChromeModel>();
const IframeScope = createNexusScope<IframeModel>();
const ChromeRemoteScope = ChromeScope.createRemoteStoreScope(chromeStore);
const chromeNexus = new Nexus<ChromeModel>();
const iframeNexus = new Nexus<IframeModel>();
const lifecycleProxy = {};
type ActiveProxyStatus = Extract<ProxyStatus, { type: "active" }>;

const fullProxyStatusSelector = (status: ProxyStatus) => status.type;
useProxyStatus(lifecycleProxy, fullProxyStatusSelector);

useProxyStatus(
  lifecycleProxy,
  // @ts-expect-error A selector must handle both active and disconnected states.
  (status: ActiveProxyStatus) => status.selection,
);

const ChromeApp = () => {
  ChromeScope.useNexus().safeConnect({
    target: { context: "chrome", tabId: 1 },
    timeout: 1_000,
  });
  ChromeScope.useNexus().ready();
  ChromeScope.useRemoteStore(chromeStore, {
    target: { context: "chrome", tabId: 1 },
  });
  const scopedStatus: RemoteStoreStatus | null = ChromeRemoteScope.useStatus();
  const scopedPhase: "ready" | null = ChromeRemoteScope.useStatus((status) =>
    status.type === "ready" ? "ready" : null,
  );

  ChromeRemoteScope.useStatus(
    // @ts-expect-error A selector must handle every remote store status.
    (status: Extract<RemoteStoreStatus, { type: "ready" }>) => status.version,
  );

  void scopedStatus;
  void scopedPhase;

  return <ChromeScope.NexusProvider nexus={chromeNexus} />;
};

const IframeApp = () => {
  IframeScope.useNexus().safeConnect({
    target: { context: "iframe", origin: "https://example.test" },
  });

  // @ts-expect-error An Iframe Nexus instance cannot provide a Chrome Context.
  return <ChromeScope.NexusProvider nexus={iframeNexus} />;
};

const DefaultApp = () => {
  useNexus().ready();

  return <NexusProvider nexus={new Nexus()} />;
};

declare const remoteStoreResult: UseRemoteStoreResult<CounterStore>;

// @ts-expect-error useStore accepts a concrete Store, not an acquisition result.
useStore(remoteStoreResult);

if (remoteStoreResult.store) {
  useStore(remoteStoreResult.store, (state) => state.count);
}

const selectedStatus: "ready" | null = useStoreStatus(
  remoteStoreResult.store,
  (status) => (status.type === "ready" ? "ready" : null),
);
const wholeStatus: RemoteStoreStatus | null = useStoreStatus(
  remoteStoreResult.store,
);

useStoreStatus(
  remoteStoreResult.store,
  // @ts-expect-error A status selector must accept the full status union.
  (status: Extract<RemoteStoreStatus, { type: "ready" }>) => status.version,
);

// @ts-expect-error Acquisition results do not expose lifecycle status.
remoteStoreResult.status;

if (remoteStoreResult.pending) {
  const pending: true = remoteStoreResult.pending;
  void pending;
} else if (remoteStoreResult.store) {
  const count: number = remoteStoreResult.store.getState().count;
  void count;
} else {
  const error: Error = remoteStoreResult.error;
  void error;
}

void selectedStatus;
void wholeStatus;

void ChromeApp;
void DefaultApp;
void IframeApp;

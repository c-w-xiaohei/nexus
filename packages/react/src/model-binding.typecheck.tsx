import {
  Nexus,
  Token,
  type AdapterModel,
  type ConnectionMetaOf,
  type ContextMetaOf,
  type ProxyStatus,
} from "@nexus-js/core";
import {
  defineNexusStore,
  type NexusStoreServiceContract,
} from "@nexus-js/core/state";
import { createNexusScope } from "./create-nexus-scope.js";
import { NexusProvider } from "./provider.js";
import { useNexus } from "./use-nexus.js";
import { useProxyStatus } from "./use-proxy-status.js";
import { useStore } from "./use-store.js";
import type { UseRemoteStoreResult } from "./use-remote-store.js";

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

const chromeStore = defineNexusStore<
  { count: number },
  { increment(): void },
  ChromeModel
>({
  token: new Token<
    NexusStoreServiceContract<{ count: number }, { increment(): void }>,
    ChromeModel
  >("state:react:model-binding:chrome"),
  state: () => ({ count: 0 }),
  actions: () => ({ increment() {} }),
});

const iframeStore = defineNexusStore<
  { count: number },
  { increment(): void },
  IframeModel
>({
  token: new Token<
    NexusStoreServiceContract<{ count: number }, { increment(): void }>,
    IframeModel
  >("state:react:model-binding:iframe"),
  state: () => ({ count: 0 }),
  actions: () => ({ increment() {} }),
});

const ChromeScope = createNexusScope<ChromeModel>();
const IframeScope = createNexusScope<IframeModel>();
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
  ChromeScope.useNexus().safeCreate(chromeStore.token);
  ChromeScope.useNexus().select(chromeStore.token, {
    where: (
      context: ContextMetaOf<ChromeModel>,
      connection: ConnectionMetaOf<ChromeModel>,
    ) => context.context === "chrome" && connection.tabId === 1,
    wait: { timeout: 1_000 },
    callTimeout: 500,
  });
  ChromeScope.useNexus().ready();
  ChromeScope.useRemoteStore(chromeStore, {
    target: { context: "chrome", tabId: 1 },
  });
  ChromeScope.createRemoteStoreScope(chromeStore);

  return <ChromeScope.NexusProvider nexus={chromeNexus} />;
};

const IframeApp = () => {
  IframeScope.useNexus().safeCreate(iframeStore.token);

  // @ts-expect-error broadcast was replaced by selectMulticast().
  IframeScope.useNexus().broadcast(iframeStore.token);

  // @ts-expect-error An Iframe Nexus instance cannot provide a Chrome Context.
  return <ChromeScope.NexusProvider nexus={iframeNexus} />;
};

const DefaultApp = () => {
  useNexus().ready();

  return <NexusProvider nexus={new Nexus()} />;
};

declare const remoteStoreResult: UseRemoteStoreResult<
  { count: number },
  { increment(): void }
>;

// @ts-expect-error useStore accepts a concrete Store, not an acquisition result.
useStore(remoteStoreResult);

void ChromeApp;
void DefaultApp;
void IframeApp;

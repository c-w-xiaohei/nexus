import {
  Nexus,
  Token,
  type AdapterModel,
  type ConnectionMetaOf,
  type ContextMetaOf,
} from "@nexus-js/core";
import {
  defineNexusStore,
  type NexusStoreServiceContract,
} from "@nexus-js/core/state";
import { createNexusScope } from "./create-nexus-scope.js";
import { NexusProvider } from "./provider.js";
import { useNexus } from "./use-nexus.js";

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

void ChromeApp;
void DefaultApp;
void IframeApp;

import { Nexus, Token } from "@/index";
import {
  connectNexusStore,
  createNexusStore,
  type DefineNexusStoreOptions,
  defineNexusStore,
  safeConnectNexusStore,
  type NexusStoreServiceContract,
  type StoreTokenMetadata,
} from "./index.js";

interface CounterState {
  count: number;
}

interface CounterActions extends Record<string, (...args: any[]) => any> {
  increment(by: number): number;
}

type ChromeContextMeta =
  | { runtime: "background" }
  | { runtime: "content-script"; tabId: number };

interface ChromeConnectionMeta {
  platform: "chrome";
}

type ChromeModel = {
  contextMeta: ChromeContextMeta;
  connectionMeta: ChromeConnectionMeta;
  connectionTarget:
    | { context: "background" }
    | { context: "content"; tabId: number };
};

type UpstreamContextMeta = { runtime: "upstream"; workerId: string };
type UpstreamModel = {
  contextMeta: UpstreamContextMeta;
  connectionMeta: ChromeConnectionMeta;
  connectionTarget: { context: "upstream" };
};

const ChromeCounterToken = new Token<
  NexusStoreServiceContract<CounterState, CounterActions>,
  ChromeModel
>("state:chrome-counter", {
  defaultTarget: {
    context: "background",
  },
});

const UpstreamCounterToken = new Token<
  NexusStoreServiceContract<CounterState, CounterActions>,
  UpstreamModel
>("state:upstream-counter", {
  defaultTarget: {
    context: "upstream",
  },
});

const chromeDefinitionInput = {
  token: ChromeCounterToken,
  state: () => ({ count: 0 }),
  actions: ({ getState, setState }) => ({
    increment(by) {
      const next = getState().count + by;
      setState({ count: next });
      return next;
    },
  }),
} satisfies DefineNexusStoreOptions<CounterState, CounterActions, ChromeModel>;

void defineNexusStore<CounterState, CounterActions>(chromeDefinitionInput);

const chromeDefinition = defineNexusStore<
  CounterState,
  CounterActions,
  typeof ChromeCounterToken
>(chromeDefinitionInput);

type ChromeDefinitionMeta = StoreTokenMetadata<typeof chromeDefinition.token>;
const assertChromeMeta: ChromeDefinitionMeta = {
  contextMeta: { runtime: "background" },
  connectionMeta: { platform: "chrome" },
  connectionTarget: { context: "background" },
};
void assertChromeMeta;

const chromeDefinitionWithDefaultTarget = defineNexusStore<
  CounterState,
  CounterActions,
  ChromeModel
>({
  token: ChromeCounterToken,
  defaultTarget: { context: "background" },
  state: () => ({ count: 0 }),
  actions: ({ getState, setState }) => ({
    increment(by) {
      const next = getState().count + by;
      setState({ count: next });
      return next;
    },
  }),
});

const chromeNexus = new Nexus<ChromeModel>();

chromeNexus.provide(createNexusStore(chromeDefinition).provider);
chromeNexus.provide(
  createNexusStore(chromeDefinitionWithDefaultTarget).provider,
);

void connectNexusStore(chromeNexus, chromeDefinition, {
  target: { context: "background" },
});
void safeConnectNexusStore(chromeNexus, chromeDefinition, {
  target: { context: "background" },
});

const upstreamDefinitionInput = {
  token: UpstreamCounterToken,
  state: () => ({ count: 0 }),
  actions: () => ({
    increment: (by) => by,
  }),
} satisfies DefineNexusStoreOptions<
  CounterState,
  CounterActions,
  UpstreamModel
>;

const upstreamDefinition = defineNexusStore<
  CounterState,
  CounterActions,
  typeof UpstreamCounterToken
>(upstreamDefinitionInput);

// @ts-expect-error connectNexusStore creates a runtime-targeted proxy and rejects unrelated token metadata.
void connectNexusStore(chromeNexus, upstreamDefinition);

// @ts-expect-error safeConnectNexusStore creates a runtime-targeted proxy and rejects unrelated token metadata.
void safeConnectNexusStore(chromeNexus, upstreamDefinition);

import { Nexus, Token } from "@/index";
import {
  connectNexusStore,
  createNexusStore,
  type DefineNexusStoreOptions,
  defineNexusStore,
  safeConnectNexusStore,
  type NexusStoreServiceContract,
  type StoreTokenMetadata,
} from "./index";

interface CounterState {
  count: number;
}

interface CounterActions extends Record<string, (...args: any[]) => any> {
  increment(by: number): number;
}

type ChromeEndpointMeta =
  | { runtime: "background" }
  | { runtime: "content-script"; tabId: number };

interface ChromePlatformMeta {
  platform: "chrome";
}

type UpstreamEndpointMeta = { runtime: "upstream"; workerId: string };

const ChromeCounterToken = new Token<
  NexusStoreServiceContract<CounterState, CounterActions>,
  ChromeEndpointMeta
>("state:chrome-counter", {
  defaultTarget: {
    descriptor: { runtime: "background" },
  },
});

const UpstreamCounterToken = new Token<
  NexusStoreServiceContract<CounterState, CounterActions>,
  UpstreamEndpointMeta
>("state:upstream-counter", {
  defaultTarget: {
    descriptor: { runtime: "upstream", workerId: "worker-1" },
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
} satisfies DefineNexusStoreOptions<
  CounterState,
  CounterActions,
  ChromeEndpointMeta
>;

void defineNexusStore<CounterState, CounterActions>(chromeDefinitionInput);

const chromeDefinition = defineNexusStore<
  CounterState,
  CounterActions,
  typeof ChromeCounterToken
>(chromeDefinitionInput);

type ChromeDefinitionMeta = StoreTokenMetadata<typeof chromeDefinition.token>;
const assertChromeMeta: ChromeDefinitionMeta = { runtime: "background" };
void assertChromeMeta;

const chromeDefinitionWithDefaultTarget = defineNexusStore<
  CounterState,
  CounterActions,
  ChromeEndpointMeta
>({
  token: ChromeCounterToken,
  defaultTarget: { descriptor: { runtime: "background" } },
  state: () => ({ count: 0 }),
  actions: ({ getState, setState }) => ({
    increment(by) {
      const next = getState().count + by;
      setState({ count: next });
      return next;
    },
  }),
});

const chromeNexus = new Nexus<ChromeEndpointMeta, ChromePlatformMeta>();

chromeNexus.provide(createNexusStore(chromeDefinition).provider);
chromeNexus.provide(
  createNexusStore(chromeDefinitionWithDefaultTarget).provider,
);

void connectNexusStore(chromeNexus, chromeDefinition, {
  target: { descriptor: { runtime: "background" } },
});
void safeConnectNexusStore(chromeNexus, chromeDefinition, {
  target: { descriptor: { runtime: "background" } },
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
  UpstreamEndpointMeta
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

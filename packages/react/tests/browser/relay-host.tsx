import { Nexus } from "@nexus-js/core";
import { createNexusStore, type RemoteActions } from "@nexus-js/core/state";
import { usingIframeParent, type IframeAdapterModel } from "@nexus-js/iframe";
import {
  RelayProfileToken,
  RELAY_APP_ID,
  RELAY_ORIGIN,
  iframeCounterStore,
  createCounterStoreCreator,
  relayFrameNonce,
  type CounterActions,
  type CounterStore,
  type RelayProfileService,
} from "./shared";

const telemetry = {
  relayReady: false,
  readyChildren: [] as string[],
  serviceCalls: [] as Array<{ childId: string }>,
  dispatchCalls: [] as Array<{ action: string; args: unknown[] }>,
};

function getRelayFrame() {
  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe[data-frame-id="relay"]`,
  );
  if (!iframe) throw new Error("Missing relay iframe");
  return iframe;
}

const profileService: RelayProfileService = {
  profile: {
    async read(childId) {
      telemetry.serviceCalls.push({ childId });
      return { childId, servedBy: "host" };
    },
    async failWithCode(code) {
      throw Object.assign(new Error(`host:${code}`), { code });
    },
  },
};

function instrumentStore(implementation: StoreImplementation) {
  const wrapper = Object.create(
    Object.getPrototypeOf(implementation),
  ) as StoreImplementation;
  Object.defineProperties(
    wrapper,
    Object.getOwnPropertyDescriptors(implementation),
  );
  wrapper.subscribe = async (onSync, ...args) => {
    const callback: Parameters<StoreImplementation["subscribe"]>[0] = async (
      event,
    ) => {
      if (event.type === "init") {
        const initEvent = event;
        const actions: RemoteActions<CounterStore> = {
          increment: async (
            ...args: Parameters<CounterActions["increment"]>
          ) => {
            telemetry.dispatchCalls.push({ action: "increment", args });
            return initEvent.actions.increment(...args);
          },
          setCount: async (...args: Parameters<CounterActions["setCount"]>) => {
            telemetry.dispatchCalls.push({ action: "setCount", args });
            return initEvent.actions.setCount(...args);
          },
          asyncIncrementSlow: async (
            ...args: Parameters<CounterActions["asyncIncrementSlow"]>
          ) => {
            telemetry.dispatchCalls.push({
              action: "asyncIncrementSlow",
              args,
            });
            return initEvent.actions.asyncIncrementSlow(...args);
          },
          failAfterNoCommit: async (
            ...args: Parameters<CounterActions["failAfterNoCommit"]>
          ) => {
            telemetry.dispatchCalls.push({
              action: "failAfterNoCommit",
              args,
            });
            return initEvent.actions.failAfterNoCommit(...args);
          },
        };
        event = { ...event, actions };
      }
      return onSync(event);
    };
    return Reflect.apply(implementation.subscribe, implementation, [
      callback,
      ...args,
    ]);
  };
  return wrapper;
}

const { provider } = createNexusStore(
  iframeCounterStore,
  createCounterStoreCreator(),
  {
    snapshot: (state: CounterStore) => ({
      count: state.count,
      writes: state.writes,
    }),
    expose: [
      "increment",
      "setCount",
      "asyncIncrementSlow",
      "failAfterNoCommit",
    ],
  },
);
type StoreImplementation = typeof provider.service;
const hostNexus = new Nexus<IframeAdapterModel>().configure({
  ...usingIframeParent({
    configure: false,
    appId: RELAY_APP_ID,
    frames: [
      {
        frameId: "relay",
        iframe: getRelayFrame(),
        origin: RELAY_ORIGIN,
        nonce: relayFrameNonce(),
      },
    ],
    // Use the default heartbeat budget; these tests exercise navigation cleanup.
  }),
  providers: [
    { token: RelayProfileToken, service: profileService },
    {
      token: provider.token,
      service: instrumentStore(provider.service),
    },
  ],
});

window.addEventListener("message", (event) => {
  const data = event.data as { type?: string; childId?: string } | undefined;
  if (data?.type === "relay-frame-ready") telemetry.relayReady = true;
  if (data?.type === "relay-child-ready" && data.childId) {
    if (!telemetry.readyChildren.includes(data.childId)) {
      telemetry.readyChildren.push(data.childId);
      telemetry.readyChildren.sort();
    }
  }
});

const relayFrame = getRelayFrame();
relayFrame.src = relayFrame.dataset.src ?? "";

function getRelayHostTelemetry() {
  return {
    relayReady: telemetry.relayReady,
    readyChildren: [...telemetry.readyChildren],
    serviceCalls: [...telemetry.serviceCalls],
    dispatchCalls: [...telemetry.dispatchCalls],
  };
}

function resetRelayReadiness() {
  telemetry.relayReady = false;
  telemetry.readyChildren = [];
}

function waitForFrameLoad(iframe: HTMLIFrameElement) {
  return new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
  });
}

async function blankRelayFrame() {
  resetRelayReadiness();
  const iframe = getRelayFrame();
  const loaded = waitForFrameLoad(iframe);
  iframe.src = "about:blank";
  await loaded;
}

async function reconnectRelayFrame() {
  resetRelayReadiness();
  const iframe = getRelayFrame();
  const loaded = waitForFrameLoad(iframe);
  iframe.src = `${RELAY_ORIGIN}/relay-frame.html?reload=${Date.now()}`;
  await loaded;
}

Object.assign(window, {
  blankRelayFrame,
  getRelayHostTelemetry,
  hostNexus,
  reconnectRelayFrame,
});

document.getElementById("host-status")!.textContent = "ready";

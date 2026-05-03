import { Nexus } from "@nexus-js/core";
import {
  provideNexusStore,
  type NexusStoreServiceContract,
} from "@nexus-js/core/state";
import { usingIframeParent } from "@nexus-js/iframe";
import {
  RelayProfileToken,
  RELAY_APP_ID,
  RELAY_ORIGIN,
  counterStore,
  relayFrameNonce,
  type CounterActions,
  type CounterState,
  type RelayProfileService,
} from "./shared";

type StoreImplementation = NexusStoreServiceContract<
  CounterState,
  CounterActions
>;

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
  wrapper.dispatch = async (action, args) => {
    telemetry.dispatchCalls.push({ action, args: [...args] });
    return implementation.dispatch(action, args);
  };
  return wrapper;
}

const registration = provideNexusStore(counterStore);
const hostNexus = new Nexus().configure({
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
    heartbeat: { intervalMs: 100, maxMisses: 2 },
  }),
  services: [
    { token: RelayProfileToken, implementation: profileService },
    {
      token: registration.token,
      implementation: instrumentStore(registration.implementation),
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

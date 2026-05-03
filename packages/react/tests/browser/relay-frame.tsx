import { Nexus } from "@nexus-js/core";
import { relayNexusStore, relayService } from "@nexus-js/core/relay";
import { usingIframeChild, usingIframeParent } from "@nexus-js/iframe";
import {
  RelayProfileToken,
  RELAY_APP_ID,
  RELAY_CHILD_IDS,
  RELAY_HOST_ORIGIN,
  RELAY_ORIGIN,
  counterStore,
  relayChildNonce,
  relayFrameNonce,
  relayHostTarget,
  type RelayChildId,
} from "./shared";

type RelayChildReadyMessage = {
  type: "relay-child-ready";
  childId: RelayChildId;
};

const telemetry = {
  servicePolicyCalls: [] as Array<{ origin: unknown; path: unknown[] }>,
  dispatchPolicyCalls: [] as Array<{ origin: unknown; action: string }>,
};

function getChildFrame(childId: string) {
  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe[data-child-id="${childId}"]`,
  );
  if (!iframe) throw new Error(`Missing relay child iframe ${childId}`);
  return iframe;
}

function setChildFrameSrcAndWaitForLoad(childId: string, src: string) {
  const iframe = getChildFrame(childId);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      iframe.removeEventListener("load", handleLoad);
      iframe.removeEventListener("error", handleError);
    };
    const handleLoad = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`Failed to load relay child iframe ${childId}`));
    };
    iframe.addEventListener("load", handleLoad, { once: true });
    iframe.addEventListener("error", handleError, { once: true });
    iframe.src = src;
  });
}

function blankRelayChild(childId: string) {
  return setChildFrameSrcAndWaitForLoad(childId, "about:blank");
}

function reconnectRelayChild(childId: string) {
  return setChildFrameSrcAndWaitForLoad(
    childId,
    `${RELAY_ORIGIN}/relay-child.html?childId=${childId}&reload=${Date.now()}`,
  );
}

function isRelayChildId(value: unknown): value is RelayChildId {
  return RELAY_CHILD_IDS.includes(value as RelayChildId);
}

function isRelayChildReadyMessage(
  value: unknown,
): value is RelayChildReadyMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "relay-child-ready" &&
    "childId" in value &&
    isRelayChildId(value.childId)
  );
}

const chromeNexus = new Nexus().configure({
  ...usingIframeChild({
    configure: false,
    appId: RELAY_APP_ID,
    frameId: "relay",
    parentOrigin: RELAY_HOST_ORIGIN,
    nonce: relayFrameNonce(),
    heartbeat: { intervalMs: 100, maxMisses: 2 },
    connectTo: [{ descriptor: relayHostTarget.descriptor }],
  }),
});

const iframeParentNexus = new Nexus().configure({
  ...usingIframeParent({
    configure: false,
    appId: RELAY_APP_ID,
    frames: RELAY_CHILD_IDS.map((childId) => ({
      frameId: childId,
      iframe: getChildFrame(childId),
      origin: RELAY_ORIGIN,
      nonce: relayChildNonce(childId),
    })),
    heartbeat: { intervalMs: 100, maxMisses: 2 },
  }),
  services: [
    relayService(RelayProfileToken, {
      forwardThrough: chromeNexus,
      forwardTarget: relayHostTarget,
      policy: {
        canCall(context) {
          telemetry.servicePolicyCalls.push({
            origin: context.origin,
            path: [...context.path],
          });
          return true;
        },
      },
    }),
    relayNexusStore(counterStore, {
      forwardThrough: chromeNexus,
      forwardTarget: relayHostTarget,
      policy: {
        canDispatch(context) {
          telemetry.dispatchPolicyCalls.push({
            origin: context.origin,
            action: context.action,
          });
          return true;
        },
      },
    }),
  ],
});

window.addEventListener("message", (event) => {
  if (!isRelayChildReadyMessage(event.data)) {
    return;
  }

  if (event.origin !== RELAY_ORIGIN) {
    return;
  }

  if (event.source !== getChildFrame(event.data.childId).contentWindow) {
    return;
  }

  window.parent.postMessage(event.data, RELAY_HOST_ORIGIN);
});

for (const childId of RELAY_CHILD_IDS) {
  const iframe = getChildFrame(childId);
  iframe.src = iframe.dataset.src ?? "";
}

function getRelayFrameTelemetry() {
  return {
    servicePolicyCalls: telemetry.servicePolicyCalls.map((call) => ({
      ...call,
      path: [...call.path],
    })),
    dispatchPolicyCalls: telemetry.dispatchPolicyCalls.map((call) => ({
      ...call,
    })),
  };
}

Object.assign(window, {
  getRelayFrameTelemetry,
  blankRelayChild,
  reconnectRelayChild,
  chromeNexus,
  iframeParentNexus,
});

window.parent.postMessage({ type: "relay-frame-ready" }, RELAY_HOST_ORIGIN);
document.getElementById("relay-status")!.textContent = "ready";

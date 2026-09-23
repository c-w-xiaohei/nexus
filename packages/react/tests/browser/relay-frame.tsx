import { Nexus } from "@nexus-js/core";
import {
  usingIframeChild,
  usingIframeParent,
  type IframeAdapterModel,
} from "@nexus-js/iframe";
import {
  RelayProfileToken,
  RELAY_APP_ID,
  RELAY_CHILD_IDS,
  RELAY_HOST_ORIGIN,
  RELAY_ORIGIN,
  iframeCounterStore,
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
  servicePolicyCalls: [] as Array<{
    serviceName: string;
    path: readonly (string | number)[];
  }>,
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

const chromeNexus = new Nexus<IframeAdapterModel>().configure({
  ...usingIframeChild({
    configure: false,
    appId: RELAY_APP_ID,
    frameId: "relay",
    parentOrigin: RELAY_HOST_ORIGIN,
    nonce: relayFrameNonce(),
  }),
});

const iframeParentNexus = new Nexus<IframeAdapterModel>().configure({
  ...usingIframeParent({
    configure: false,
    appId: RELAY_APP_ID,
    frames: RELAY_CHILD_IDS.map((childId) => ({
      frameId: childId,
      iframe: getChildFrame(childId),
      origin: RELAY_ORIGIN,
      nonce: relayChildNonce(childId),
    })),
  }),
  policy: {
    canCall(context) {
      telemetry.servicePolicyCalls.push({
        serviceName: context.serviceName,
        path: [...context.path],
      });
      return true;
    },
  },
});

Nexus.relay({
  from: iframeParentNexus,
  to: { nexus: chromeNexus, target: relayHostTarget },
  services: [RelayProfileToken, iframeCounterStore],
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
      serviceName: call.serviceName,
      path: [...call.path],
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

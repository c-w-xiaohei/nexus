import { Nexus, Token } from "@nexus-js/core";
import {
  usingIframeParent,
  type IframeAdapterModel,
  type IframeConnectionMeta,
  type IframeContextMeta,
  type IframeConnectionTarget,
} from "@nexus-js/iframe";

interface EchoService {
  echo(value: string): Promise<string>;
}

interface ParentEchoService {
  echoFromParent(value: string): Promise<string>;
}

const EchoToken = new Token<EchoService>("browser.echo");
const ParentEchoToken = new Token<ParentEchoService>("browser.parent-echo");
const connectToMode =
  new URLSearchParams(window.location.search).get("mode") === "connect-to";

const frameIds = ["alpha", "beta"] as const;
const telemetry = {
  parentCalls: [] as Array<{ frameId: string; value: string }>,
  childCalls: [] as Array<{ frameId: string; value: string }>,
  binaryDataEnvelopes: 0,
  loadedFrames: [] as string[],
  parentConnectAttempts: 0,
  selectResolved: false,
};
const childEchoServices = new Map<string, EchoService>();
let connectToSelection: Promise<EchoService> | undefined;

function isBinaryDataEnvelope(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const envelope = data as {
    __nexusIframe?: unknown;
    payload?: {
      __nexusVirtualPort?: unknown;
      type?: unknown;
      payload?: unknown;
    };
  };
  return (
    envelope.__nexusIframe === true &&
    envelope.payload?.__nexusVirtualPort === true &&
    envelope.payload.type === "data" &&
    envelope.payload.payload instanceof ArrayBuffer
  );
}

window.addEventListener(
  "message",
  (event) => {
    if (isBinaryDataEnvelope(event.data)) telemetry.binaryDataEnvelopes += 1;
  },
  { capture: true },
);

function getFrame(frameId: string) {
  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe[data-frame-id="${frameId}"]`,
  );
  if (!iframe) throw new Error(`Missing child iframe ${frameId}`);
  return iframe;
}

const parentConfig = usingIframeParent({
  configure: false,
  appId: "browser-app",
  frames: frameIds.map((frameId) => ({
    frameId,
    iframe: getFrame(frameId),
    origin: "http://127.0.0.1:3211",
    nonce: `browser-nonce-${frameId}`,
  })),
  heartbeat: { intervalMs: 100, maxMisses: 2 },
});
const parentEndpoint = parentConfig.endpoint?.implementation;
if (!parentEndpoint) throw new Error("Missing iframe parent endpoint");
const connect = parentEndpoint.connect.bind(parentEndpoint);
parentEndpoint.connect = async (target: IframeConnectionTarget) => {
  telemetry.parentConnectAttempts += 1;
  return connect(target);
};

const parent = new Nexus<IframeAdapterModel>().configure({
  ...parentConfig,
  providers: [
    {
      token: ParentEchoToken,
      service: {
        async echoFromParent(value: string) {
          const frameId = value.split(":", 1)[0] ?? "unknown";
          telemetry.parentCalls.push({
            frameId,
            value: value.slice(frameId.length + 1),
          });
          return `parent:${value}`;
        },
      },
    },
  ],
});

window.addEventListener("message", (event) => {
  const data = event.data as { type?: string; frameId?: string } | undefined;
  if (data?.type !== "child-ready" || !data.frameId) return;
  if (!telemetry.loadedFrames.includes(data.frameId)) {
    telemetry.loadedFrames.push(data.frameId);
  }
});

for (const frameId of frameIds) {
  const iframe = getFrame(frameId);
  if (!connectToMode) iframe.src = iframe.dataset.src ?? "";
}

async function callChildEcho(frameId: string, value: string) {
  const service = await parent.create(EchoToken, {
    target: {
      context: "iframe-child",
      appId: "browser-app",
      frameId,
    },
  });
  const response = await service.echo(value);
  telemetry.childCalls.push({ frameId, value });
  return response;
}

async function callCachedChildEcho(frameId: string, value: string) {
  let service = childEchoServices.get(frameId);
  if (!service) {
    service = await parent.create(EchoToken, {
      target: {
        context: "iframe-child",
        appId: "browser-app",
        frameId,
      },
    });
    childEchoServices.set(frameId, service);
  }
  return service.echo(value);
}

function getTelemetry() {
  return {
    parentCalls: [...telemetry.parentCalls],
    childCalls: [...telemetry.childCalls],
    binaryDataEnvelopes: telemetry.binaryDataEnvelopes,
    loadedFrames: [...telemetry.loadedFrames],
    parentConnectAttempts: telemetry.parentConnectAttempts,
    selectResolved: telemetry.selectResolved,
  };
}

function selectConnectToChild() {
  telemetry.selectResolved = false;
  connectToSelection = parent.select(EchoToken, {
    where: (
      contextMeta: IframeContextMeta,
      connectionMeta: IframeConnectionMeta,
    ) =>
      contextMeta.context === "iframe-child" &&
      connectionMeta.frameId === "alpha",
    wait: { timeout: 5_000 },
  });
  void connectToSelection.then(
    () => {
      telemetry.selectResolved = true;
    },
    () => {},
  );
}

async function startConnectToSelection(bootstrap = "module") {
  if (!connectToMode) throw new Error("connect-to mode is required");
  if (connectToSelection) throw new Error("Selection already started");
  await parent.ready();
  selectConnectToChild();
  const iframe = getFrame("alpha");
  iframe.src = `${iframe.dataset.src}&mode=connect-to&bootstrap=${bootstrap}`;
}

async function callConnectToSelectedChild(value: string) {
  if (!connectToSelection) throw new Error("Selection has not started");
  const service = await connectToSelection;
  return service.echo(value);
}

async function reloadFrame(frameId: string) {
  telemetry.loadedFrames = telemetry.loadedFrames.filter(
    (id) => id !== frameId,
  );
  childEchoServices.delete(frameId);
  const iframe = getFrame(frameId);
  iframe.src = `http://127.0.0.1:3211/child.html?frameId=${frameId}&reload=${Date.now()}`;
}

Object.assign(window, {
  callCachedChildEcho,
  callChildEcho,
  getTelemetry,
  reloadFrame,
  startConnectToSelection,
  selectConnectToChild,
  callConnectToSelectedChild,
  parentNexus: parent,
});

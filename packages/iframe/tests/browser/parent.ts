import { Nexus, Token } from "@nexus-js/core";
import { usingIframeParent } from "@nexus-js/iframe";

interface EchoService {
  echo(value: string): Promise<string>;
}

interface ParentEchoService {
  echoFromParent(value: string): Promise<string>;
}

const EchoToken = new Token<EchoService>("browser.echo");
const ParentEchoToken = new Token<ParentEchoService>("browser.parent-echo");

const frameIds = ["alpha", "beta"] as const;
const telemetry = {
  parentCalls: [] as Array<{ frameId: string; value: string }>,
  childCalls: [] as Array<{ frameId: string; value: string }>,
  readyFrames: [] as string[],
};
const childEchoServices = new Map<string, EchoService>();

function getFrame(frameId: string) {
  const iframe = document.querySelector<HTMLIFrameElement>(
    `iframe[data-frame-id="${frameId}"]`,
  );
  if (!iframe) throw new Error(`Missing child iframe ${frameId}`);
  return iframe;
}

const parent = new Nexus().configure({
  ...usingIframeParent({
    configure: false,
    appId: "browser-app",
    frames: frameIds.map((frameId) => ({
      frameId,
      iframe: getFrame(frameId),
      origin: "http://127.0.0.1:3210",
      nonce: `browser-nonce-${frameId}`,
    })),
    heartbeat: { intervalMs: 100, maxMisses: 2 },
  }),
  services: [
    {
      token: ParentEchoToken,
      implementation: {
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
  if (!telemetry.readyFrames.includes(data.frameId)) {
    telemetry.readyFrames.push(data.frameId);
  }
});

async function callChildEcho(frameId: string, value: string) {
  const service = await parent.create(EchoToken, {
    target: {
      descriptor: {
        context: "iframe-child",
        appId: "browser-app",
        frameId,
      },
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
        descriptor: {
          context: "iframe-child",
          appId: "browser-app",
          frameId,
        },
      },
    });
    childEchoServices.set(frameId, service);
  }
  return service.echo(value);
}

async function callParentEcho(frameId: string, value: string) {
  const iframe = getFrame(frameId);
  const childWindow = iframe.contentWindow as Window & {
    callParentEcho?: (value: string) => Promise<string>;
  };
  if (!childWindow.callParentEcho) {
    throw new Error(`Child ${frameId} is not ready`);
  }
  return childWindow.callParentEcho(value);
}

function getTelemetry() {
  const liveReadyFrames = frameIds.filter((frameId) => {
    const childWindow = getFrame(frameId).contentWindow as Window & {
      nexusIframeReady?: boolean;
    };
    return childWindow.nexusIframeReady === true;
  });
  return {
    parentCalls: [...telemetry.parentCalls],
    childCalls: [...telemetry.childCalls],
    readyFrames: Array.from(
      new Set([...telemetry.readyFrames, ...liveReadyFrames]),
    ),
  };
}

async function reloadFrame(frameId: string) {
  telemetry.readyFrames = telemetry.readyFrames.filter((id) => id !== frameId);
  childEchoServices.delete(frameId);
  const iframe = getFrame(frameId);
  iframe.src = `http://127.0.0.1:3210/child.html?frameId=${frameId}&reload=${Date.now()}`;
}

function makeChildUnresponsive(frameId: string) {
  const iframe = getFrame(frameId);
  const childWindow = iframe.contentWindow as Window & {
    makeUnresponsive?: () => void;
  };
  if (!childWindow.makeUnresponsive) {
    throw new Error(`Child ${frameId} is not ready`);
  }
  childWindow.makeUnresponsive();
}

function sendSpoofedConnect(options: { channel?: string; nonce?: string }) {
  window.postMessage(
    {
      __nexusIframe: true,
      appId: "browser-app",
      channel: options.channel ?? "nexus:iframe",
      nonce: options.nonce ?? "browser-nonce-alpha",
      payload: {
        __nexusVirtualPort: true,
        version: 1,
        type: "connect",
        channelId: "attacker-channel",
        from: "attacker",
        nonce: "attacker-nonce",
      },
    },
    "http://127.0.0.1:3210",
  );
}

Object.assign(window, {
  callCachedChildEcho,
  callChildEcho,
  callParentEcho,
  getTelemetry,
  reloadFrame,
  sendSpoofedConnect,
  makeChildUnresponsive,
  parentNexus: parent,
});

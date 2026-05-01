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
      origin: "http://127.0.0.1:3211",
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

for (const frameId of frameIds) {
  const iframe = getFrame(frameId);
  iframe.src = iframe.dataset.src ?? "";
}

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

function getTelemetry() {
  return {
    parentCalls: [...telemetry.parentCalls],
    childCalls: [...telemetry.childCalls],
    readyFrames: [...telemetry.readyFrames],
  };
}

async function reloadFrame(frameId: string) {
  telemetry.readyFrames = telemetry.readyFrames.filter((id) => id !== frameId);
  childEchoServices.delete(frameId);
  const iframe = getFrame(frameId);
  iframe.src = `http://127.0.0.1:3211/child.html?frameId=${frameId}&reload=${Date.now()}`;
}

Object.assign(window, {
  callCachedChildEcho,
  callChildEcho,
  getTelemetry,
  reloadFrame,
  parentNexus: parent,
});

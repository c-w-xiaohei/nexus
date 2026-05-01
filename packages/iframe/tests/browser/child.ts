import { Nexus, Token } from "@nexus-js/core";
import { usingIframeChild } from "@nexus-js/iframe";

interface EchoService {
  echo(value: string): Promise<string>;
}

interface ParentEchoService {
  echoFromParent(value: string): Promise<string>;
}

const EchoToken = new Token<EchoService>("browser.echo");
const ParentEchoToken = new Token<ParentEchoService>("browser.parent-echo");
const frameId = new URLSearchParams(window.location.search).get("frameId");
if (!frameId) throw new Error("Missing frameId query parameter");

type BrowserEventListener = Parameters<typeof window.addEventListener>[1];
type BrowserAddOptions = Parameters<typeof window.addEventListener>[2];
type BrowserRemoveOptions = Parameters<typeof window.removeEventListener>[2];

const messageListeners: BrowserEventListener[] = [];
const addEventListener = window.addEventListener.bind(window);
const removeEventListener = window.removeEventListener.bind(window);
function trackedAddEventListener(
  this: Window,
  type: string,
  listener: BrowserEventListener | null,
  options?: BrowserAddOptions,
) {
  if (type === "message" && listener) messageListeners.push(listener);
  if (!listener) return;
  addEventListener(type, listener, options);
}
function trackedRemoveEventListener(
  this: Window,
  type: string,
  listener: BrowserEventListener | null,
  options?: BrowserRemoveOptions,
) {
  if (type === "message" && listener) {
    const index = messageListeners.indexOf(listener);
    if (index >= 0) messageListeners.splice(index, 1);
  }
  if (!listener) return;
  removeEventListener(type, listener, options);
}
window.addEventListener = trackedAddEventListener;
window.removeEventListener = trackedRemoveEventListener;

const child = new Nexus().configure({
  ...usingIframeChild({
    configure: false,
    appId: "browser-app",
    frameId,
    parentOrigin: "http://127.0.0.1:3210",
    nonce: `browser-nonce-${frameId}`,
    heartbeat: { intervalMs: 100, maxMisses: 2 },
    connectTo: [
      { descriptor: { context: "iframe-parent", appId: "browser-app" } },
    ],
  }),
  services: [
    {
      token: EchoToken,
      implementation: {
        async echo(value: string) {
          return `child:${frameId}:${value}`;
        },
      },
    },
  ],
});

async function callParentEcho(value: string) {
  const service = await child.create(ParentEchoToken, {
    target: {
      descriptor: { context: "iframe-parent", appId: "browser-app" },
    },
  });
  return service.echoFromParent(`${frameId}:${value}`);
}

function makeUnresponsive() {
  for (const listener of [...messageListeners]) {
    window.removeEventListener("message", listener);
  }
}

Object.assign(window, {
  callParentEcho,
  makeUnresponsive,
  childNexus: child,
  nexusIframeReady: true,
});
window.parent.postMessage(
  { type: "child-ready", frameId },
  "http://127.0.0.1:3210",
);

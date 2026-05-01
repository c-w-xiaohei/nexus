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

const child = new Nexus().configure({
  ...usingIframeChild({
    configure: false,
    appId: "browser-app",
    frameId,
    parentOrigin: "http://127.0.0.1:3210",
    nonce: `browser-nonce-${frameId}`,
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

Object.assign(window, { callParentEcho, childNexus: child });
window.parent.postMessage(
  { type: "child-ready", frameId },
  "http://127.0.0.1:3210",
);

import { Nexus, Token } from "@nexus-js/core";
import { usingIframeParent } from "@nexus-js/iframe";

interface EchoService {
  echo(value: string): Promise<string>;
}

const EchoToken = new Token<EchoService>("browser.echo");

const iframe = document.querySelector<HTMLIFrameElement>("#child");
if (!iframe) throw new Error("Missing child iframe");

const parent = new Nexus().configure(
  usingIframeParent({
    configure: false,
    appId: "browser-app",
    frames: [
      {
        frameId: "main",
        iframe,
        origin: "http://127.0.0.1:3210",
        nonce: "browser-nonce",
      },
    ],
  }),
);

async function callChildEcho(value: string) {
  const service = await parent.create(EchoToken, {
    target: {
      descriptor: {
        context: "iframe-child",
        appId: "browser-app",
        frameId: "main",
      },
    },
  });
  return service.echo(value);
}

Object.assign(window, { callChildEcho, parentNexus: parent });

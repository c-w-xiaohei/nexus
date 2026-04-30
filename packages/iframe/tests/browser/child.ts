import { Nexus, Token } from "@nexus-js/core";
import { usingIframeChild } from "@nexus-js/iframe";

interface EchoService {
  echo(value: string): Promise<string>;
}

const EchoToken = new Token<EchoService>("browser.echo");

const child = new Nexus().configure({
  ...usingIframeChild({
    configure: false,
    appId: "browser-app",
    frameId: "main",
    parentOrigin: "http://127.0.0.1:3210",
    nonce: "browser-nonce",
    connectTo: [
      { descriptor: { context: "iframe-parent", appId: "browser-app" } },
    ],
  }),
  services: [
    {
      token: EchoToken,
      implementation: {
        async echo(value: string) {
          return `child:${value}`;
        },
      },
    },
  ],
});

Object.assign(window, { childNexus: child });

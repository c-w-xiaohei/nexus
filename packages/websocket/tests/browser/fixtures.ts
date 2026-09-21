import { createServer } from "node:http";
import { once } from "node:events";
import { URL, fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createServer as createViteServer } from "vite";
import { Nexus } from "@nexus-js/core";
import { createNexusStore } from "@nexus-js/core/state";
import {
  WebSocketServerEndpoint,
  type WebSocketAdapterModel,
} from "@nexus-js/websocket/server";
import {
  CounterStoreToken,
  EchoToken,
  RefToken,
  type CounterRef,
  type CounterStore,
  type EchoService,
  type RefService,
} from "./contracts";
import { test as base } from "@playwright/test";

export interface WebSocketBrowserFixture {
  readonly origin: string;
  readonly websocketUrl: string;
  dropConnections(): void;
}

type WebSocketFacts = { readonly origin: string };

export const test = base.extend<{ websocket: WebSocketBrowserFixture }>({
  websocket: async ({}, use) => {
    const endpoint = new WebSocketServerEndpoint<WebSocketFacts>({
      maxConnections: 8,
    });
    const counterStore = createNexusStore<
      CounterStore,
      WebSocketAdapterModel<WebSocketFacts>
    >(
      CounterStoreToken,
      (set, get) => ({
        count: 0,
        increment(by) {
          const count = get().count + by;
          set({ count });
          return count;
        },
      }),
      { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
    );
    const nexus = new Nexus<WebSocketAdapterModel<WebSocketFacts>>();
    nexus.configure({
      endpoint: {
        meta: { context: "websocket-server" },
        implementation: endpoint,
      },
      providers: [
        {
          token: EchoToken,
          service: {
            async echo(value) {
              return value;
            },
            async invokeCallback(value, callback) {
              await callback(value);
            },
          } satisfies EchoService,
        },
        {
          token: RefToken,
          service: {
            async openCounter() {
              let count = 0;
              const counter: CounterRef = {
                increment() {
                  count += 1;
                  return count;
                },
                current() {
                  return count;
                },
              };
              return nexus.ref(counter);
            },
          } satisfies RefService,
        },
        counterStore.provider,
      ],
    });
    await nexus.ready();

    const vite = await createViteServer({
      configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
      appType: "spa",
      server: { middlewareMode: true, ws: false, hmr: false },
    });
    const httpServer = createServer(vite.middlewares);
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const address = httpServer.address();
    if (!address || typeof address === "string")
      throw new Error("Vite did not expose an ephemeral address");

    const origin = `http://127.0.0.1:${address.port}`;
    const websocketServer = new WebSocketServer({
      server: httpServer,
      path: "/ws",
    });
    websocketServer.on("connection", (socket) => {
      endpoint.attach(socket, { origin });
    });

    const fixture: WebSocketBrowserFixture = {
      origin,
      websocketUrl: `${origin.replace("http:", "ws:")}/ws`,
      dropConnections() {
        for (const socket of websocketServer.clients) socket.terminate();
      },
    };

    try {
      await use(fixture);
    } finally {
      endpoint.close();
      await new Promise<void>((resolve) =>
        websocketServer.close(() => resolve()),
      );
      counterStore.destroy();
      await vite.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
});

export { expect } from "@playwright/test";

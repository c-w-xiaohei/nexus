import { Nexus, type DisconnectReason } from "@nexus-js/core";
import { connectNexusStore } from "@nexus-js/core/state";
import {
  WebSocketClientEndpoint,
  type WebSocketAdapterModel,
  type WebSocketTarget,
} from "@nexus-js/websocket";
import { CounterStoreToken, EchoToken, RefToken } from "./contracts";

async function openSession(url: string) {
  const endpoint = new WebSocketClientEndpoint({
    protocols: ["nexus-browser.v1"],
  });
  const client = new Nexus<WebSocketAdapterModel>().configure({
    endpoint: {
      meta: { context: "websocket-client" },
      implementation: endpoint,
    },
  });
  const target: WebSocketTarget = { context: "websocket-server", url };
  try {
    await client.ready();
    const connection = await client.connect({ target });
    const counter = await connection.get(RefToken).openCounter();
    const store = await connectNexusStore(client, CounterStoreToken, {
      target,
    });
    const disconnected = new Promise<DisconnectReason>((resolve) =>
      connection.onDisconnected(resolve),
    );
    return {
      client,
      endpoint,
      target,
      connection,
      counter,
      store,
      disconnected,
    };
  } catch (error) {
    endpoint.close();
    throw error;
  }
}

// Only one scenario owns resources in a page; Playwright creates a new page per test.
let session: Awaited<ReturnType<typeof openSession>> | undefined;

function currentSession() {
  if (!session) throw new Error("No active browser session");
  return session;
}

async function failureCode(operation: () => PromiseLike<unknown>) {
  try {
    await operation();
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error) return error.code;
    throw error;
  }
}

const harness = {
  async runRpcScenario(url: string) {
    session = await openSession(url);
    const { connection, counter, store } = session;
    try {
      if (connection.connectionMeta.role !== "client")
        throw new Error("Expected client facts");
      const echo = connection.get(EchoToken);
      const callback: string[] = [];
      const echoed = await echo.echo("browser-rpc");
      await echo.invokeCallback("browser-callback", async (value) => {
        callback.push(value);
      });
      return {
        protocol: connection.connectionMeta.protocol,
        echoed,
        callback,
        ref: {
          first: await counter.increment(),
          current: await counter.current(),
        },
        state: {
          actionResult: await store.actions.increment(3),
          count: store.getState().count,
        },
      };
    } finally {
      harness.cleanup();
    }
  },

  async prepareDisconnectScenario(url: string) {
    session = await openSession(url);
    return {
      sessionId: session.connection.id,
      ref: await session.counter.increment(),
      state: await session.store.actions.increment(2),
    };
  },

  waitForDisconnect() {
    return currentSession().disconnected;
  },

  async reconnect() {
    const old = currentSession();
    await old.disconnected;
    const staleCallCode = await failureCode(() =>
      old.connection.get(EchoToken).echo("stale"),
    );
    const staleRefCode = await failureCode(() => old.counter.current());
    const fresh = await old.client.connect({ target: old.target });
    const counter = await fresh.get(RefToken).openCounter();
    const store = await connectNexusStore(old.client, CounterStoreToken, {
      target: old.target,
    });
    try {
      const initialState = store.getState().count;
      return {
        initialSessionStatus: old.connection.status,
        staleCallCode,
        staleRefCode,
        freshSessionId: fresh.id,
        freshSessionStatus: fresh.status,
        freshRefInitial: await counter.current(),
        freshRefValue: await counter.increment(),
        initialState,
        state: await store.actions.increment(5),
        snapshot: store.getState().count,
      };
    } finally {
      store.destroy();
    }
  },

  cleanup() {
    session?.store.destroy();
    session?.endpoint.close();
    session = undefined;
  },
};

declare global {
  interface Window {
    websocketHarness: typeof harness;
  }
}

globalThis.window.websocketHarness = harness;

import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { WebSocketServerEndpoint } from "../../server.js";

export type UpgradeGate = {
  readonly entered: Promise<void>;
  readonly released: Promise<void>;
  readonly enter: () => void;
  readonly release: () => void;
  readonly cancel: () => void;
};

export function createUpgradeGate(): UpgradeGate {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    released: released.promise,
    enter: () => entered.resolve(),
    release: () => released.resolve(),
    cancel: () => released.resolve(),
  };
}

export type WebSocketHost = {
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly url: string;
  readonly sockets: ReadonlySet<WebSocket>;
  readonly rawSockets: ReadonlySet<Duplex>;
  readonly upgradeCount: number;
  readonly close: () => Promise<void>;
};

export async function createWebSocketHost<Facts extends object>(
  endpoint:
    | WebSocketServerEndpoint<Facts>
    | (() => WebSocketServerEndpoint<Facts>),
  facts: Facts | ((request: IncomingMessage) => Facts),
  options: {
    readonly responseBody?: string;
    readonly upgradeGate?: UpgradeGate;
  } = {},
): Promise<WebSocketHost> {
  return createRawWebSocketHost((socket, request) => {
    const socketFacts = typeof facts === "function" ? facts(request) : facts;
    // Upgrade and endpoint ownership happen in the same host callback.
    (typeof endpoint === "function" ? endpoint() : endpoint).attach(
      socket,
      socketFacts,
    );
  }, options);
}

export async function createRawWebSocketHost(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
  options: {
    readonly responseBody?: string;
    readonly upgradeGate?: UpgradeGate;
  } = {},
): Promise<WebSocketHost> {
  const server = createServer((_request, response) =>
    response.end(options.responseBody ?? "host-alive"),
  );
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const rawSockets = new Set<Duplex>();
  const upgradeErrors: unknown[] = [];
  let upgradeCount = 0;
  wss.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket, request);
  });
  server.on("upgrade", (request, socket, head) => {
    upgradeCount += 1;
    rawSockets.add(socket);
    socket.once("close", () => rawSockets.delete(socket));
    const upgrade = () => {
      if (socket.destroyed) return;
      try {
        wss.handleUpgrade(request, socket, head, (webSocket) => {
          wss.emit("connection", webSocket, request);
        });
      } catch (error) {
        upgradeErrors.push(error);
        socket.destroy(error instanceof Error ? error : undefined);
      }
    };
    if (options.upgradeGate) {
      options.upgradeGate.enter();
      void options.upgradeGate.released.then(upgrade).catch((error) => {
        upgradeErrors.push(error);
        socket.destroy(error instanceof Error ? error : undefined);
      });
      return;
    }
    upgrade();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an IPv4 loopback listener");
  }
  return {
    server,
    wss,
    url: `ws://127.0.0.1:${address.port}`,
    sockets,
    rawSockets,
    get upgradeCount() {
      return upgradeCount;
    },
    async close() {
      const rawCloseResults = await Promise.allSettled(
        [...rawSockets].map((socket) => {
          const closed = waitForSocketClose(socket);
          socket.destroy();
          return closed;
        }),
      );
      options.upgradeGate?.cancel();
      const results = await Promise.allSettled([
        ...[...sockets].map(async (socket) => socket.terminate()),
        new Promise<void>((resolve, reject) =>
          wss.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      errors.push(
        ...rawCloseResults.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
      );
      errors.push(...upgradeErrors);
      if (errors.length)
        throw new AggregateError(errors, "WebSocket host cleanup failed");
    },
  };
}

export async function openWs(
  url: string,
  protocols?: string | string[],
): Promise<WebSocket> {
  const socket = new WebSocket(url, protocols);
  await once(socket, "open");
  return socket;
}

export async function closeWs(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

export function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return once(socket, "close").then(() => undefined);
}

export function waitForSocketClose(socket: Duplex): Promise<void> {
  if ((socket as Duplex & { readonly closed?: boolean }).closed === true)
    return Promise.resolve();
  return once(socket, "close").then(() => undefined);
}

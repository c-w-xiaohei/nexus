import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { Nexus, Token } from "@nexus-js/core";
import { WebSocketClientEndpoint } from "../../dist/index.mjs";
import { WebSocketServerEndpoint } from "../../dist/server.mjs";

// Run the same built modules under Node or Bun: Bun's ws shim may return an
// ArrayBufferView despite binaryType=arraybuffer. Only real RPC proves that the
// compatibility layer and Nexus handshake agree on the packet representation.
test("native client completes Nexus handshake and RPC through node:http + ws", async () => {
  const token = new Token("runtime:ws:echo");
  const endpoint = new WebSocketServerEndpoint();
  const clientEndpoint = new WebSocketClientEndpoint();
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const upgradedSockets = new Set();
  const server = new Nexus().configure({
    endpoint: {
      implementation: endpoint,
      meta: { context: "websocket-server" },
    },
    providers: [{ token, service: { echo: async (value) => value } }],
  });
  const client = new Nexus().configure({
    endpoint: {
      implementation: clientEndpoint,
      meta: { context: "websocket-client" },
    },
  });
  try {
    await Promise.all([server.ready(), client.ready()]);
    http.on("upgrade", (request, socket, head) => {
      upgradedSockets.add(socket);
      socket.once("close", () => upgradedSockets.delete(socket));
      wss.handleUpgrade(request, socket, head, (ws) => {
        const attached = endpoint.safeAttach(ws, { runtime: "compatibility" });
        if (attached.isErr()) ws.terminate();
        assert.equal(attached.isOk(), true);
      });
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const connection = await client.connect({
      target: {
        context: "websocket-server",
        url: `ws://127.0.0.1:${address.port}`,
      },
      timeout: 2_000,
    });
    assert.equal(connection.status, "connected");
    assert.equal(
      await connection.get(token).echo("runtime-round-trip"),
      "runtime-round-trip",
    );
  } finally {
    clientEndpoint.close();
    endpoint.close();
    for (const socket of upgradedSockets) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    http.closeAllConnections();
    if (http.listening) await new Promise((resolve) => http.close(resolve));
  }
});

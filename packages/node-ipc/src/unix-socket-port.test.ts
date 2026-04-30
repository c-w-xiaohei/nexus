import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { UnixSocketPort } from "./ports/unix-socket-port";

const sockets: net.Socket[] = [];

const createSocketPair = async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("expected TCP address");

  const accepted = new Promise<net.Socket>((resolve) =>
    server.once("connection", resolve),
  );
  const client = net.createConnection(address.port, "127.0.0.1");
  const serverSocket = await accepted;
  sockets.push(client, serverSocket);
  server.close();
  return [
    new UnixSocketPort(client),
    new UnixSocketPort(serverSocket),
  ] as const;
};

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

describe("UnixSocketPort", () => {
  it("posts ArrayBuffer messages to the peer", async () => {
    const [client, server] = await createSocketPair();
    const received = new Promise<ArrayBuffer>((resolve) =>
      server.onMessage(resolve),
    );

    client.postMessage(Uint8Array.from([1, 2, 3]).buffer);

    await expect(received).resolves.toEqual(Uint8Array.from([1, 2, 3]).buffer);
  });

  it("notifies disconnect handlers and closes sockets", async () => {
    const [client, server] = await createSocketPair();
    const disconnected = new Promise<void>((resolve) =>
      server.onDisconnect(resolve),
    );

    client.close();

    await expect(disconnected).resolves.toBeUndefined();
  });

  it("notifies disconnect when posting to a destroyed socket", async () => {
    const [client] = await createSocketPair();
    const disconnected = new Promise<void>((resolve) =>
      client.onDisconnect(resolve),
    );

    client.close();
    client.postMessage(Uint8Array.from([1]).buffer);

    await expect(disconnected).resolves.toBeUndefined();
  });
});

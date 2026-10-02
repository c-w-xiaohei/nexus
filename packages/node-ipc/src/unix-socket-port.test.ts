import net from "node:net";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnixSocketPort } from "./ports/unix-socket-port";
import { BinaryFrame } from "./framing/binary-frame";

const sockets: net.Socket[] = [];

const unwrap = <T, E>(result: import("better-result").Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

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
    client,
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

    await client.postMessage(Uint8Array.from([1, 2, 3]).buffer);

    await expect(received).resolves.toEqual(Uint8Array.from([1, 2, 3]).buffer);
  });

  it("receives large packets across fragmented headers and sticky socket data", async () => {
    const [, server, rawSocket] = await createSocketPair();
    const payload = new Uint8Array(96 * 1024).map((_, index) => index % 251);
    const firstPacket = new Uint8Array([1, 2, 3]).buffer;
    const encodedLarge = unwrap(BinaryFrame.encode(payload.buffer));
    const encodedSmall = unwrap(BinaryFrame.encode(firstPacket));
    const largeFrame = new Uint8Array(encodedLarge);
    const smallFrame = new Uint8Array(encodedSmall);
    const sticky = new Uint8Array(largeFrame.length + smallFrame.length);
    sticky.set(largeFrame);
    sticky.set(smallFrame, largeFrame.length);
    const received: ArrayBuffer[] = [];
    const allReceived = new Promise<void>((resolve) =>
      server.onMessage((message) => {
        received.push(message);
        if (received.length === 2) resolve();
      }),
    );

    rawSocket.write(sticky.subarray(0, 2));
    rawSocket.write(sticky.subarray(2, 7));
    rawSocket.write(sticky.subarray(7));

    await allReceived;
    expect(new Uint8Array(received[0])).toEqual(payload);
    expect(new Uint8Array(received[1])).toEqual(new Uint8Array(firstPacket));
  });

  it("sends and receives one packet larger than the default frame policy", async () => {
    const [client, server] = await createSocketPair();
    const payload = new Uint8Array(96 * 1024).map((_, index) => index % 251);
    const received = new Promise<ArrayBuffer>((resolve) =>
      server.onMessage(resolve),
    );

    await client.postMessage(payload.buffer);

    await expect(received).resolves.toEqual(payload.buffer);
  });

  it("receives fragmented and sticky frames from an independent process", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("expected TCP address");
    let port: UnixSocketPort | undefined;
    const accepted = new Promise<void>((resolve) =>
      server.once("connection", (socket) => {
        sockets.push(socket);
        port = new UnixSocketPort(socket);
        resolve();
      }),
    );
    const payload = Buffer.alloc(96 * 1024, 0x5a);
    const small = Buffer.from([1, 2, 3]);
    const largeFrame = Buffer.alloc(4 + payload.length);
    largeFrame.writeUInt32BE(payload.length);
    payload.copy(largeFrame, 4);
    const smallFrame = Buffer.alloc(4 + small.length);
    smallFrame.writeUInt32BE(small.length);
    small.copy(smallFrame, 4);
    const first = Buffer.concat([largeFrame, smallFrame]);
    const script = [
      'const net=require("node:net");',
      "const chunks=[];",
      'process.stdin.on("data",chunk=>chunks.push(chunk));',
      'process.stdin.on("end",()=>{',
      `const data=Buffer.concat(chunks);const socket=net.createConnection(${address.port},"127.0.0.1",()=>{`,
      "socket.write(data.subarray(0,2));",
      "socket.write(data.subarray(2,7));",
      "socket.end(data.subarray(7));",
      "});",
      "});",
    ].join("");
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.end(first);
    const childExited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
      );
    });
    const received: ArrayBuffer[] = [];
    const allReceived = new Promise<void>((resolve) =>
      accepted.then(() => {
        port!.onMessage((message) => {
          received.push(message);
          if (received.length === 2) resolve();
        });
      }),
    );

    try {
      await Promise.all([accepted, childExited, allReceived]);
      expect(new Uint8Array(received[0])).toEqual(new Uint8Array(payload));
      expect(new Uint8Array(received[1])).toEqual(new Uint8Array(small));
    } finally {
      port?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      child.kill();
    }
  });

  it("writes a backpressured frame once and settles after drain", async () => {
    const socket = new EventEmitter() as net.Socket;
    const write = vi.fn((_data: Buffer, callback: (error?: Error) => void) => {
      setImmediate(() => callback());
      return false;
    });
    Object.assign(socket, {
      destroyed: false,
      writable: true,
      write,
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const port = new UnixSocketPort(socket);

    let settled = false;
    const pending = port.postMessage(Uint8Array.from([1, 2, 3]).buffer);
    void pending.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(write).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    socket.emit("drain");
    await expect(pending).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps the socket open for failures before native write submission", async () => {
    const socket = new EventEmitter() as net.Socket;
    const write = vi.fn(() => true);
    Object.assign(socket, {
      destroyed: false,
      writable: true,
      write,
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const port = new UnixSocketPort(socket);
    const disconnected = vi.fn();
    port.onDisconnect(disconnected);
    const aborted = new AbortController();
    aborted.abort();

    await expect(port.postMessage(new ArrayBuffer(0))).rejects.toMatchObject({
      code: "E_IPC_PROTOCOL_ERROR",
    });
    await expect(
      port.postMessage(new Uint8Array([1]).buffer, undefined, aborted.signal),
    ).rejects.toMatchObject({ code: "E_IPC_CONNECT_FAILED" });

    expect(write).not.toHaveBeenCalled();
    expect(socket.end).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
  });

  it("rejects a backpressured write when its signal aborts", async () => {
    const socket = new EventEmitter() as net.Socket;
    Object.assign(socket, {
      destroyed: false,
      writable: true,
      write: vi.fn(() => false),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const port = new UnixSocketPort(socket);
    const disconnected = vi.fn();
    port.onDisconnect(disconnected);
    const controller = new AbortController();
    const removeAbortListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    const pending = port.postMessage(
      new Uint8Array([1]).buffer,
      undefined,
      controller.signal,
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "E_IPC_CONNECT_FAILED",
    });
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount("drain")).toBe(0);
    expect(socket.listenerCount("close")).toBe(1);
    expect(socket.listenerCount("error")).toBe(1);
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("closes the port when a submitted write reports an error", async () => {
    const socket = new EventEmitter() as net.Socket;
    const write = vi.fn((_data: Buffer, callback: (error?: Error) => void) => {
      setImmediate(() => callback(new Error("write failed")));
      return false;
    });
    Object.assign(socket, {
      destroyed: false,
      writable: true,
      write,
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const port = new UnixSocketPort(socket);
    const disconnected = vi.fn();
    port.onDisconnect(disconnected);

    await expect(
      port.postMessage(new Uint8Array([1]).buffer),
    ).rejects.toMatchObject({
      code: "E_IPC_CONNECT_FAILED",
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount("drain")).toBe(0);
  });

  it("closes the port when a submitted write reaches its deadline", async () => {
    vi.useFakeTimers();
    const socket = new EventEmitter() as net.Socket;
    const write = vi.fn(() => false);
    Object.assign(socket, {
      destroyed: false,
      writable: true,
      write,
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const port = new UnixSocketPort(socket);
    const disconnected = vi.fn();
    port.onDisconnect(disconnected);
    const pending = port.postMessage(new Uint8Array([1]).buffer);
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await outcome).toMatchObject({ code: "E_IPC_CONNECT_FAILED" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(socket.end).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount("drain")).toBe(0);
    vi.useRealTimers();
  });

  it("rejects a backpressured write when the socket closes", async () => {
    const socket = new EventEmitter() as net.Socket;
    Object.assign(socket, {
      destroyed: false,
      writable: true,
      write: vi.fn(() => false),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const port = new UnixSocketPort(socket);
    const pending = port.postMessage(new Uint8Array([1]).buffer);

    socket.emit("close");

    await expect(pending).rejects.toMatchObject({
      code: "E_IPC_CONNECT_FAILED",
    });
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
    await expect(
      client.postMessage(Uint8Array.from([1]).buffer),
    ).rejects.toMatchObject({
      code: "E_IPC_CONNECT_FAILED",
    });

    await expect(disconnected).resolves.toBeUndefined();
  });
});

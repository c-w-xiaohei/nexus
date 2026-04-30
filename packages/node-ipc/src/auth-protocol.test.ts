import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnixSocketClientEndpoint } from "./endpoints/unix-socket-client";
import { UnixSocketServerEndpoint } from "./endpoints/unix-socket-server";
import { createHarness, type TestHarness } from "./integration-test-utils";

let harness: TestHarness | undefined;
let server: net.Server | undefined;
let serverSocket: net.Socket | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    serverSocket?.destroy();
    server.close(() => resolve());
  });
  serverSocket = undefined;
  server = undefined;
  await harness?.cleanup();
  harness = undefined;
});

describe("node-ipc auth protocol", () => {
  it("maps malformed server auth responses to a stable protocol error", async () => {
    harness = await createHarness();
    server = net.createServer((socket) => {
      serverSocket = socket;
      socket.write('{"type":"unexpected"}\n');
    });
    if (harness.address.kind !== "path")
      throw new Error("expected path socket");
    const socketPath = harness.address.path;
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const EndpointWithAuth = UnixSocketClientEndpoint as unknown as new (
      resolveAddress: () => NonNullable<typeof harness>["address"],
      authToken: string,
    ) => UnixSocketClientEndpoint;
    const endpoint = new EndpointWithAuth(() => harness!.address, "secret");

    await expect(
      endpoint.connect({ context: "node-ipc-daemon", appId: "test-daemon" }),
    ).rejects.toMatchObject({ code: "E_IPC_PROTOCOL_ERROR" });
  });

  it("buffers split server auth responses until a newline", async () => {
    harness = await createHarness();
    server = net.createServer((socket) => {
      serverSocket = socket;
      socket.write('{"type":"nexus');
      setTimeout(() => socket.write('-ipc-auth-ok"}\n'), 0);
    });
    if (harness.address.kind !== "path")
      throw new Error("expected path socket");
    const socketPath = harness.address.path;
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const endpoint = new UnixSocketClientEndpoint(
      () => harness!.address,
      "secret",
    );

    const [port, meta] = await endpoint.connect({
      context: "node-ipc-daemon",
      appId: "test-daemon",
    });

    expect(meta.authenticated).toBe(true);
    expect(meta.authMethod).toBe("shared-secret");
    expect(meta).not.toHaveProperty("pid");
    expect(meta).not.toHaveProperty("uid");
    expect(meta).not.toHaveProperty("gid");
    port.close();
  });

  it("buffers split client auth requests until a newline", async () => {
    harness = await createHarness();
    if (harness.address.kind !== "path")
      throw new Error("expected path socket");
    const socketPath = harness.address.path;
    const onConnect = vi.fn();
    const endpoint = new UnixSocketServerEndpoint(harness.address, "secret");
    await endpoint.listen(onConnect);
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    socket.write('{"type":"nexus-ipc-auth","version":1,');
    setTimeout(() => socket.write('"token":"secret"}\n'), 0);

    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
    expect(onConnect.mock.calls[0][1]).toMatchObject({
      authenticated: true,
      authMethod: "shared-secret",
    });
    expect(onConnect.mock.calls[0][1]).not.toHaveProperty("pid");
    expect(onConnect.mock.calls[0][1]).not.toHaveProperty("uid");
    expect(onConnect.mock.calls[0][1]).not.toHaveProperty("gid");
    socket.destroy();
    endpoint.close();
  });

  it("fails authentication when a server accepts but sends no auth response", async () => {
    harness = await createHarness();
    server = net.createServer((socket) => {
      serverSocket = socket;
    });
    if (harness.address.kind !== "path")
      throw new Error("expected path socket");
    const socketPath = harness.address.path;
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const EndpointWithOptions = UnixSocketClientEndpoint as unknown as new (
      resolveAddress: () => NonNullable<typeof harness>["address"],
      authToken: string,
      options: { authTimeoutMs: number },
    ) => UnixSocketClientEndpoint;
    const endpoint = new EndpointWithOptions(() => harness!.address, "secret", {
      authTimeoutMs: 10,
    });

    await expect(
      endpoint.connect({ context: "node-ipc-daemon", appId: "test-daemon" }),
    ).rejects.toMatchObject({ code: "E_IPC_AUTH_FAILED" });
  });

  it("rejects an empty auth token passed to the raw server endpoint constructor", async () => {
    harness = await createHarness();

    expect(() => new UnixSocketServerEndpoint(harness!.address, "")).toThrow(
      expect.objectContaining({ code: "E_IPC_AUTH_FAILED" }),
    );
  });

  it("rejects an empty auth token passed to the raw client endpoint constructor", async () => {
    harness = await createHarness();

    expect(
      () => new UnixSocketClientEndpoint(() => harness!.address, ""),
    ).toThrow(expect.objectContaining({ code: "E_IPC_AUTH_FAILED" }));
  });

  it("keeps rejecting an empty auth token when server listen is called", async () => {
    harness = await createHarness();
    const EndpointWithEmptyAuth = UnixSocketServerEndpoint as unknown as new (
      address: NonNullable<typeof harness>["address"],
    ) => UnixSocketServerEndpoint;
    const endpoint = new EndpointWithEmptyAuth(harness.address);
    Object.defineProperty(endpoint, "authToken", { value: "" });

    await expect(endpoint.listen(vi.fn())).rejects.toMatchObject({
      code: "E_IPC_AUTH_FAILED",
    });
  });

  it("keeps rejecting an empty auth token when client connect is called", async () => {
    harness = await createHarness();
    const EndpointWithEmptyAuth = UnixSocketClientEndpoint as unknown as new (
      resolveAddress: () => NonNullable<typeof harness>["address"],
    ) => UnixSocketClientEndpoint;
    const endpoint = new EndpointWithEmptyAuth(() => harness!.address);
    Object.defineProperty(endpoint, "authToken", { value: "" });

    await expect(
      endpoint.connect({ context: "node-ipc-daemon", appId: "test-daemon" }),
    ).rejects.toMatchObject({ code: "E_IPC_AUTH_FAILED" });
  });

  it("closes the client socket when pre-auth fails", async () => {
    harness = await createHarness();
    let clientSocket: net.Socket | undefined;
    const createConnection = vi.spyOn(net, "createConnection");
    createConnection.mockImplementation(((
      ...args: Parameters<typeof net.createConnection>
    ) => {
      const socket = net.connect(...args) as net.Socket;
      clientSocket = socket;
      return socket;
    }) as typeof net.createConnection);
    server = net.createServer((socket) => {
      serverSocket = socket;
      socket.write('{"type":"unexpected"}\n');
    });
    if (harness.address.kind !== "path")
      throw new Error("expected path socket");
    const socketPath = harness.address.path;
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const endpoint = new UnixSocketClientEndpoint(
      () => harness!.address,
      "secret",
    );

    await expect(
      endpoint.connect({ context: "node-ipc-daemon", appId: "test-daemon" }),
    ).rejects.toMatchObject({ code: "E_IPC_PROTOCOL_ERROR" });

    expect(clientSocket?.destroyed).toBe(true);
    createConnection.mockRestore();
  });

  it("rejects oversized client auth requests before newline", async () => {
    harness = await createHarness();
    if (harness.address.kind !== "path")
      throw new Error("expected path socket");
    const endpoint = new UnixSocketServerEndpoint(harness.address, "secret", {
      maxAuthLineBytes: 16,
    } as any);
    await endpoint.listen(vi.fn());
    const socket = net.createConnection(harness.address.path);
    await new Promise<void>((resolve) => socket.once("connect", resolve));

    socket.write("x".repeat(17));

    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    endpoint.close();
  });

  it("rejects oversized server auth responses before newline", async () => {
    harness = await createHarness();
    let clientSocket: net.Socket | undefined;
    const createConnection = vi.spyOn(net, "createConnection");
    createConnection.mockImplementation(((
      ...args: Parameters<typeof net.createConnection>
    ) => {
      const socket = net.connect(...args) as net.Socket;
      clientSocket = socket;
      return socket;
    }) as typeof net.createConnection);
    server = net.createServer((socket) => {
      serverSocket = socket;
      socket.write("x".repeat(17));
    });
    if (harness.address.kind !== "path")
      throw new Error("expected path socket");
    const socketPath = harness.address.path;
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const endpoint = new UnixSocketClientEndpoint(
      () => harness!.address,
      "secret",
      { maxAuthLineBytes: 16 } as any,
    );

    await expect(
      endpoint.connect({ context: "node-ipc-daemon", appId: "test-daemon" }),
    ).rejects.toMatchObject({ code: "E_IPC_PROTOCOL_ERROR" });
    expect(clientSocket?.destroyed).toBe(true);
    createConnection.mockRestore();
  });
});

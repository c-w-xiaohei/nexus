import fs from "node:fs/promises";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { usingNodeIpcClient, usingNodeIpcDaemon } from "./factory";

describe("Node IPC factories", () => {
  it("creates daemon config with listen endpoint, metadata, and binary capabilities", () => {
    const config = usingNodeIpcDaemon({
      appId: "daemon",
      instance: "alpha",
      configure: false,
    });
    const implementation = config.endpoint?.implementation;

    expect(config.endpoint?.meta).toMatchObject({
      context: "node-ipc-daemon",
      appId: "daemon",
      instance: "alpha",
    });
    expect(implementation?.listen).toBeTypeOf("function");
    expect(implementation?.capabilities).toEqual({
      binaryPackets: true,
      transferables: false,
    });
  });

  it("creates client config with connect endpoint and singular defaultTarget", () => {
    const config = usingNodeIpcClient({
      appId: "client",
      defaultTarget: { context: "node-ipc-daemon", appId: "daemon" },
      configure: false,
    });
    const implementation = config.endpoint?.implementation;

    expect(config.endpoint?.meta).toMatchObject({
      context: "node-ipc-client",
      appId: "client",
    });
    expect(implementation?.connect).toBeTypeOf("function");
    expect(config.endpoint?.defaultTarget).toEqual({
      context: "node-ipc-daemon",
      appId: "daemon",
    });
    expect("connectTo" in (config.endpoint ?? {})).toBe(false);
  });

  it("uses one target key for omitted and explicit default instances", () => {
    const config = usingNodeIpcClient({
      appId: "client",
      configure: false,
    });
    const targetKey = config.endpoint?.implementation?.targetKey;

    expect(targetKey?.({ context: "node-ipc-daemon", appId: "daemon" })).toBe(
      targetKey?.({
        context: "node-ipc-daemon",
        appId: "daemon",
        instance: "default",
      }),
    );
  });

  it("normalizes and freezes selected target values returned by connect", async () => {
    const socketPath = `/tmp/nexus-node-ipc-target-${process.pid}-${Date.now()}.sock`;
    const config = usingNodeIpcClient({
      appId: "client",
      resolveAddress: () => ({ kind: "path", path: socketPath }),
      configure: false,
    });
    const endpoint = config.endpoint?.implementation;
    if (!endpoint?.connect) throw new Error("expected connect endpoint");

    const server = await new Promise<net.Server>((resolve) => {
      const listener = net.createServer();
      listener.listen(socketPath, () => resolve(listener));
    });

    try {
      const connection = await endpoint.connect({
        context: "node-ipc-daemon",
        appId: "daemon",
      });

      expect(connection.connectionMeta.selected).toEqual({
        context: "node-ipc-daemon",
        appId: "daemon",
        instance: "default",
      });
      expect(Object.isFrozen(connection.connectionMeta.selected)).toBe(true);
      connection.port.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    }
  });

  it("matches normalized target, resolved socket, and remote daemon identity", () => {
    const config = usingNodeIpcClient({
      appId: "client",
      resolveAddress: () => ({ kind: "path", path: "/tmp/daemon.sock" }),
      configure: false,
    });
    const matchesTarget = config.endpoint?.implementation?.matchesTarget;

    expect(
      matchesTarget?.(
        { context: "node-ipc-daemon", appId: "daemon" },
        {
          context: "node-ipc-daemon",
          appId: "daemon",
          instance: "default",
          pid: 42,
        },
        {
          selected: {
            context: "node-ipc-daemon",
            appId: "daemon",
            instance: "default",
          },
          resolved: { kind: "path", path: "/tmp/daemon.sock" },
          observed: {
            socket: { kind: "path", path: "/tmp/daemon.sock" },
            authenticated: false,
            authMethod: "none",
          },
        },
      ),
    ).toBe(true);
    expect(
      matchesTarget?.(
        { context: "node-ipc-daemon", appId: "daemon" },
        {
          context: "node-ipc-client",
          appId: "daemon",
          pid: 42,
        },
        {
          selected: {
            context: "node-ipc-daemon",
            appId: "daemon",
          },
          resolved: { kind: "path", path: "/tmp/daemon.sock" },
          observed: {
            socket: { kind: "path", path: "/tmp/daemon.sock" },
            authenticated: true,
            authMethod: "shared-secret",
          },
        },
      ),
    ).toBe(false);
    expect(
      matchesTarget?.(
        { context: "node-ipc-daemon", appId: "daemon", instance: "other" },
        {
          context: "node-ipc-daemon",
          appId: "daemon",
          instance: "default",
          pid: 42,
        },
        {
          selected: {
            context: "node-ipc-daemon",
            appId: "daemon",
          },
          resolved: { kind: "path", path: "/tmp/daemon.sock" },
          observed: {
            socket: { kind: "path", path: "/tmp/daemon.sock" },
            authenticated: true,
          },
        },
      ),
    ).toBe(false);
    expect(
      matchesTarget?.(
        { context: "node-ipc-daemon", appId: "daemon" },
        {
          context: "node-ipc-daemon",
          appId: "daemon",
          pid: 42,
        },
        {
          selected: { context: "node-ipc-daemon", appId: "daemon" },
          resolved: { kind: "path", path: "/tmp/other.sock" },
          observed: {
            socket: { kind: "path", path: "/tmp/other.sock" },
            authenticated: true,
          },
        },
      ),
    ).toBe(false);
  });

  it("does not reuse a connection when target resolution fails", () => {
    const config = usingNodeIpcClient({
      appId: "client",
      resolveAddress: () => null,
      configure: false,
    });
    const matchesTarget = config.endpoint?.implementation?.matchesTarget;

    expect(
      matchesTarget?.(
        { context: "node-ipc-daemon", appId: "daemon" },
        {
          context: "node-ipc-daemon",
          appId: "daemon",
          pid: 42,
        },
        {
          selected: { context: "node-ipc-daemon", appId: "daemon" },
          resolved: { kind: "path", path: "/tmp/daemon.sock" },
          observed: {
            socket: { kind: "path", path: "/tmp/daemon.sock" },
            authenticated: true,
          },
        },
      ),
    ).toBe(false);
  });

  it("rejects explicit daemon addresses that are not absolute paths", () => {
    let error: unknown;
    try {
      usingNodeIpcDaemon({
        appId: "daemon",
        address: { kind: "path", path: "relative.sock" },
        configure: false,
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({ code: "E_IPC_ADDRESS_INVALID" });
  });

  it("rejects empty daemon auth tokens at configuration time", () => {
    let error: unknown;
    try {
      usingNodeIpcDaemon({ appId: "daemon", authToken: "", configure: false });
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({ code: "E_IPC_AUTH_FAILED" });
  });

  it("rejects empty client auth tokens at configuration time", () => {
    let error: unknown;
    try {
      usingNodeIpcClient({ appId: "client", authToken: "", configure: false });
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({ code: "E_IPC_AUTH_FAILED" });
  });

  it("preserves path-too-long errors for explicit daemon addresses", () => {
    let error: unknown;
    try {
      usingNodeIpcDaemon({
        appId: "daemon",
        address: { kind: "path", path: `/${"x".repeat(108)}` },
        configure: false,
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({ code: "E_IPC_PATH_TOO_LONG" });
  });
});

import { describe, expect, it } from "vitest";
import { usingNodeIpcClient, usingNodeIpcDaemon } from "./factory";
import { NodeIpcMatchers } from "./matchers";

describe("Node IPC factories", () => {
  it("creates daemon config with listen endpoint, metadata, descriptors, matchers, and binary capabilities", () => {
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
    expect(config.descriptors?.daemon).toEqual({
      context: "node-ipc-daemon",
      appId: "daemon",
      instance: "alpha",
    });
    expect(
      config.matchers?.daemon({
        context: "node-ipc-daemon",
        appId: "daemon",
        pid: 1,
      }),
    ).toBe(true);
  });

  it("registers concrete group matchers only for configured groups", () => {
    const config = usingNodeIpcDaemon({
      appId: "daemon",
      groups: ["dev"],
      configure: false,
    });

    expect(config.matchers?.group).toBeUndefined();
    expect(
      config.matchers?.dev({
        context: "node-ipc-client",
        appId: "client",
        groups: ["dev"],
        pid: 1,
      }),
    ).toBe(true);
    expect(
      config.matchers?.dev({
        context: "node-ipc-client",
        appId: "client",
        groups: ["ops"],
        pid: 1,
      }),
    ).toBe(false);
  });

  it("creates client config with connect endpoint and optional connectTo", () => {
    const config = usingNodeIpcClient({
      appId: "client",
      connectTo: [
        { descriptor: { context: "node-ipc-daemon", appId: "daemon" } },
      ],
      configure: false,
    });
    const implementation = config.endpoint?.implementation;

    expect(config.endpoint?.meta).toMatchObject({
      context: "node-ipc-client",
      appId: "client",
    });
    expect(implementation?.connect).toBeTypeOf("function");
    expect(config.endpoint?.connectTo).toEqual([
      { descriptor: { context: "node-ipc-daemon", appId: "daemon" } },
    ]);
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

describe("NodeIpcMatchers", () => {
  it("matches daemon, client, instance, and group", () => {
    expect(
      NodeIpcMatchers.daemon("app")({
        context: "node-ipc-daemon",
        appId: "app",
        pid: 1,
      }),
    ).toBe(true);
    expect(
      NodeIpcMatchers.client("app")({
        context: "node-ipc-client",
        appId: "app",
        pid: 1,
      }),
    ).toBe(true);
    expect(
      NodeIpcMatchers.instance("prod")({
        context: "node-ipc-daemon",
        appId: "app",
        instance: "prod",
        pid: 1,
      }),
    ).toBe(true);
    expect(
      NodeIpcMatchers.group("ops")({
        context: "node-ipc-client",
        appId: "app",
        groups: ["ops"],
        pid: 1,
      }),
    ).toBe(true);
    expect(
      NodeIpcMatchers.group("dev")({
        context: "node-ipc-client",
        appId: "app",
        groups: ["ops"],
        pid: 1,
      }),
    ).toBe(false);
  });
});

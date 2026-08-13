import { describe, expect, it } from "vitest";
import { NodeIpcAddress } from "./types/address";

const unwrap = <T, E>(result: import("better-result").Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

describe("NodeIpcAddress", () => {
  it("resolves daemon descriptors under XDG runtime dir with default instance", () => {
    const result = NodeIpcAddress.defaultResolve(
      { context: "node-ipc-daemon", appId: "cli" },
      { env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 },
    );
    const value = unwrap(result);

    expect(value).toEqual({
      kind: "path",
      path: "/run/user/1000/nexus/cli/default.sock",
    });
  });

  it("falls back to /tmp/nexus-uid and preserves explicit instance", () => {
    const result = NodeIpcAddress.defaultResolve(
      { context: "node-ipc-daemon", appId: "cli", instance: "preview" },
      { env: {}, uid: 501 },
    );
    const value = unwrap(result);

    expect(value).toEqual({
      kind: "path",
      path: "/tmp/nexus-501/cli/preview.sock",
    });
  });

  it("surfaces custom resolver null as address invalid", () => {
    const result = NodeIpcAddress.resolve(
      { context: "node-ipc-daemon", appId: "cli" },
      () => null,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({ code: "E_IPC_ADDRESS_INVALID" });
    }
  });

  it("validates Unix socket path length", () => {
    const result = NodeIpcAddress.validate({
      kind: "path",
      path: `/${"a".repeat(108)}`,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({ code: "E_IPC_PATH_TOO_LONG" });
    }
  });

  it("preserves default resolver path-too-long errors through resolve", () => {
    const result = NodeIpcAddress.resolve({
      context: "node-ipc-daemon",
      appId: "a".repeat(120),
    });

    expect(result.isErr()).toBe(true);
  });

  it("rejects default appId and instance path traversal segments", () => {
    const appResult = NodeIpcAddress.defaultResolve(
      { context: "node-ipc-daemon", appId: "../evil" },
      { env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 },
    );
    const instanceResult = NodeIpcAddress.defaultResolve(
      { context: "node-ipc-daemon", appId: "cli", instance: "prod/blue" },
      { env: { XDG_RUNTIME_DIR: "/run/user/1000" }, uid: 1000 },
    );

    expect(appResult.isErr()).toBe(true);
    expect(instanceResult.isErr()).toBe(true);
    if (appResult.isErr()) {
      expect(appResult.error).toMatchObject({ code: "E_IPC_ADDRESS_INVALID" });
    }
    if (instanceResult.isErr()) {
      expect(instanceResult.error).toMatchObject({
        code: "E_IPC_ADDRESS_INVALID",
      });
    }
  });

  it("rejects relative custom socket paths", () => {
    const result = NodeIpcAddress.validate({
      kind: "path",
      path: "tmp/app.sock",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({ code: "E_IPC_ADDRESS_INVALID" });
    }
  });

  it("turns custom resolver throws into address invalid", () => {
    const result = NodeIpcAddress.resolve(
      { context: "node-ipc-daemon", appId: "cli" },
      () => {
        throw new Error("boom");
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({ code: "E_IPC_ADDRESS_INVALID" });
    }
  });
});

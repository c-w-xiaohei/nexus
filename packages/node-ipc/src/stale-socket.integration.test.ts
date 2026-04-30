import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnixSocketServerEndpoint } from "./endpoints/unix-socket-server";
import type { UnixSocketServerHandle } from "./endpoints/unix-socket-server";
import type { NodeIpcSocketAddress } from "./types/address";

const roots: string[] = [];

const tempSocket = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-ipc-"));
  roots.push(root);
  return {
    kind: "path",
    path: path.join(root, "daemon.sock"),
  } satisfies NodeIpcSocketAddress;
};

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe("Unix socket stale cleanup", () => {
  it("does not remove a non-socket file at the socket path", async () => {
    const address = await tempSocket();
    await fs.writeFile(address.path, "stale");
    const endpoint = new UnixSocketServerEndpoint(address);

    const result = await endpoint.safeListen(() => {});

    expect(result._unsafeUnwrapErr().code).toBe(
      "E_IPC_STALE_SOCKET_CLEANUP_FAILED",
    );
    await expect(fs.readFile(address.path, "utf8")).resolves.toBe("stale");
  });

  it("does not steal a live daemon socket", async () => {
    const address = await tempSocket();
    const first = new UnixSocketServerEndpoint(address);
    const second = new UnixSocketServerEndpoint(address);
    const closer: UnixSocketServerHandle = await first
      .safeListen(() => {})
      .then((result) => result._unsafeUnwrap() as UnixSocketServerHandle);

    const result = await second.safeListen(() => {});

    expect(result._unsafeUnwrapErr().code).toBe("E_IPC_ADDRESS_IN_USE");
    closer.close();
  });

  it("rejects symlinked runtime directories before touching the socket path", async () => {
    const realRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "nexus-node-ipc-real-"),
    );
    const linkRoot = path.join(
      os.tmpdir(),
      `nexus-node-ipc-link-${process.pid}-${Date.now()}`,
    );
    roots.push(realRoot, linkRoot);
    await fs.symlink(realRoot, linkRoot, "dir");
    const socketPath = path.join(linkRoot, "daemon.sock");
    const endpoint = new UnixSocketServerEndpoint({
      kind: "path",
      path: socketPath,
    });

    const result = await endpoint.safeListen(() => {});

    expect(result._unsafeUnwrapErr().code).toBe("E_IPC_ADDRESS_INVALID");
    await expect(fs.lstat(socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform !== "win32")(
    "allows a user-owned runtime root below normal root-owned system ancestors",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-ipc-"));
      roots.push(root);
      await fs.chmod(root, 0o755);
      const runtimeRoot = path.join(root, "user", "1000");
      await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      await fs.chmod(runtimeRoot, 0o700);
      const socketPath = path.join(runtimeRoot, "nexus", "daemon.sock");
      const endpoint = new UnixSocketServerEndpoint({
        kind: "path",
        path: socketPath,
      });
      if (typeof process.getuid !== "function") {
        throw new Error("Expected getuid on non-Windows platform");
      }
      const uid = process.getuid();
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid);

      const result = await endpoint.safeListen(() => {});

      expect(result.isOk()).toBe(true);
      result._unsafeUnwrap().close();
      getuid.mockRestore();
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects broad permissions on a preexisting runtime parent before touching the socket path",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-ipc-"));
      roots.push(root);
      await fs.chmod(root, 0o777);
      const socketPath = path.join(root, "nested", "daemon.sock");
      const endpoint = new UnixSocketServerEndpoint({
        kind: "path",
        path: socketPath,
      });

      const result = await endpoint.safeListen(() => {});

      expect(result._unsafeUnwrapErr()).toMatchObject({
        code: "E_IPC_ADDRESS_INVALID",
      });
      await expect(fs.lstat(socketPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.stat(root)).resolves.toMatchObject({ mode: 0o40777 });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects attacker-owned sticky runtime parents before touching the socket path",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-ipc-"));
      roots.push(root);
      await fs.chmod(root, 0o1777);
      const socketPath = path.join(root, "nested", "daemon.sock");
      const endpoint = new UnixSocketServerEndpoint({
        kind: "path",
        path: socketPath,
      });

      const result = await endpoint.safeListen(() => {});

      expect(result._unsafeUnwrapErr()).toMatchObject({
        code: "E_IPC_ADDRESS_INVALID",
      });
      await expect(fs.lstat(socketPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects non-directory runtime parents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-ipc-"));
    roots.push(root);
    const blockedParent = path.join(root, "not-a-directory");
    const address = {
      kind: "path",
      path: path.join(blockedParent, "daemon.sock"),
    } satisfies NodeIpcSocketAddress;
    const endpoint = new UnixSocketServerEndpoint(address);
    await fs.writeFile(blockedParent, "block directory creation");

    const result = await endpoint.safeListen(() => {});

    expect(result._unsafeUnwrapErr()).toMatchObject({
      name: "NodeIpcError",
      code: "E_IPC_ADDRESS_INVALID",
    });
  });
});

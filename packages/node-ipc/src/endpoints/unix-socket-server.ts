import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { IEndpoint, IPort } from "@nexus-js/core";
import { ResultAsync } from "neverthrow";
import { NodeIpcError } from "../errors";
import { UnixSocketPort } from "../ports/unix-socket-port";
import type { NodeIpcSocketAddress } from "../types/address";
import type { NodeIpcPlatformMeta, NodeIpcUserMeta } from "../types/meta";

export type UnixSocketServerHandle = {
  close(): void;
};

type EndpointCapabilities = NonNullable<
  IEndpoint<NodeIpcUserMeta, NodeIpcPlatformMeta>["capabilities"]
>;

const createCapabilities = (): EndpointCapabilities => {
  const capabilities = {
    binaryPackets: true,
    transferables: false,
  } as unknown as EndpointCapabilities;
  Object.defineProperty(capabilities, "supportsTransferables", {
    value: false,
    enumerable: false,
  });
  return capabilities;
};

export class UnixSocketServerEndpoint implements IEndpoint<
  NodeIpcUserMeta,
  NodeIpcPlatformMeta
> {
  readonly capabilities = createCapabilities();
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly address: NodeIpcSocketAddress,
    private readonly authToken?: string,
    private readonly options: {
      authTimeoutMs?: number;
      maxAuthLineBytes?: number;
    } = {},
  ) {
    validateAuthToken(authToken);
  }

  listen(
    onConnect: (port: IPort, platformMetadata?: NodeIpcPlatformMeta) => void,
  ): Promise<UnixSocketServerHandle> {
    return this.listenUnsafe(onConnect);
  }

  private async listenUnsafe(
    onConnect: (port: IPort, platformMetadata?: NodeIpcPlatformMeta) => void,
  ): Promise<UnixSocketServerHandle> {
    return await this.safeListen(onConnect).then((result) =>
      result.match(
        (handle) => handle,
        (error) => {
          throw error;
        },
      ),
    );
  }

  safeListen(
    onConnect: (port: IPort, platformMetadata?: NodeIpcPlatformMeta) => void,
  ): ResultAsync<UnixSocketServerHandle, NodeIpcError> {
    return ResultAsync.fromPromise<UnixSocketServerHandle, NodeIpcError>(
      this.listenInternal(onConnect),
      (cause) => toNodeIpcError(cause, "E_IPC_CONNECT_FAILED"),
    );
  }

  private async listenInternal(
    onConnect: (port: IPort, platformMetadata?: NodeIpcPlatformMeta) => void,
  ): Promise<UnixSocketServerHandle> {
    validateAuthToken(this.authToken);
    if (this.address.kind !== "path")
      throw new NodeIpcError(
        "Abstract sockets are reserved but not implemented",
        "E_IPC_ADDRESS_INVALID",
      );

    const socketPath = this.address.path;
    const socketDir = path.dirname(socketPath);
    await ensureSafeRuntimeParents(socketDir);
    await fs.mkdir(socketDir, {
      recursive: true,
      mode: 0o700,
    });
    await ensureSafeRuntimeDir(socketDir);
    await cleanupStaleSocket(socketPath);

    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      void this.acceptSocket(socket, onConnect);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    return {
      close: () => {
        this.close();
      },
    };
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.address.kind === "path") {
      void fs.unlink(this.address.path).catch(() => undefined);
    }
  }

  private async acceptSocket(
    socket: net.Socket,
    onConnect: (port: IPort, platformMetadata?: NodeIpcPlatformMeta) => void,
  ): Promise<void> {
    if (this.authToken === undefined) {
      onConnect(
        new UnixSocketPort(socket),
        this.createPlatformMeta(false, "none"),
      );
      return;
    }

    try {
      await readAuthRequest(socket, this.authToken, this.options);
      socket.write(JSON.stringify({ type: "nexus-ipc-auth-ok" }) + "\n");
      onConnect(
        new UnixSocketPort(socket),
        this.createPlatformMeta(true, "shared-secret"),
      );
    } catch (cause) {
      socket.destroy();
    }
  }

  private createPlatformMeta(
    authenticated: boolean,
    authMethod: NodeIpcPlatformMeta["authMethod"],
  ): NodeIpcPlatformMeta {
    return {
      socket: this.address,
      authenticated,
      authMethod,
    };
  }
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_AUTH_LINE_BYTES = 8 * 1024;

function validateAuthToken(authToken: string | undefined): void {
  if (authToken === "") {
    throw new NodeIpcError(
      "IPC auth token must not be empty",
      "E_IPC_AUTH_FAILED",
    );
  }
}

function readAuthRequest(
  socket: net.Socket,
  expectedToken: string,
  options: { authTimeoutMs?: number; maxAuthLineBytes?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    const maxAuthLineBytes =
      options.maxAuthLineBytes ?? DEFAULT_MAX_AUTH_LINE_BYTES;
    const timeout = setTimeout(
      () =>
        finish(
          new NodeIpcError("IPC authentication timed out", "E_IPC_AUTH_FAILED"),
        ),
      authTimeoutMs,
    );
    const finish = (error?: NodeIpcError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (cause: Error) =>
      finish(
        new NodeIpcError(
          "IPC authentication failed",
          "E_IPC_AUTH_FAILED",
          cause,
        ),
      );
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > maxAuthLineBytes) {
        finish(
          new NodeIpcError(
            "Auth request exceeded maximum line size",
            "E_IPC_PROTOCOL_ERROR",
          ),
        );
        return;
      }
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      let message: unknown;
      try {
        message = JSON.parse(buffer.slice(0, newlineIndex));
      } catch (cause) {
        finish(
          new NodeIpcError(
            "Malformed auth request",
            "E_IPC_PROTOCOL_ERROR",
            cause,
          ),
        );
        return;
      }
      if (!isAuthRequest(message)) {
        finish(
          new NodeIpcError("Malformed auth request", "E_IPC_PROTOCOL_ERROR"),
        );
        return;
      }
      if (message.token !== expectedToken) {
        finish(
          new NodeIpcError("IPC authentication failed", "E_IPC_AUTH_FAILED"),
        );
        return;
      }
      finish();
    };

    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function isAuthRequest(
  value: unknown,
): value is { type: "nexus-ipc-auth"; version: 1; token: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "nexus-ipc-auth" &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { token?: unknown }).token === "string"
  );
}

async function cleanupStaleSocket(socketPath: string): Promise<void> {
  let stats;
  try {
    stats = await fs.lstat(socketPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new NodeIpcError(
      "Could not inspect socket path",
      "E_IPC_ADDRESS_INVALID",
      cause,
    );
  }

  if (!stats.isSocket()) {
    throw new NodeIpcError(
      "Refusing to remove non-socket file at Unix socket path",
      "E_IPC_STALE_SOCKET_CLEANUP_FAILED",
    );
  }

  const live = await wrapCleanupError(
    canConnect(socketPath),
    "Could not probe existing socket",
  );
  if (live)
    throw new NodeIpcError(
      "Unix socket address is already in use",
      "E_IPC_ADDRESS_IN_USE",
    );

  try {
    await fs.unlink(socketPath);
  } catch (cause) {
    throw new NodeIpcError(
      "Could not remove stale socket",
      "E_IPC_STALE_SOCKET_CLEANUP_FAILED",
      cause,
    );
  }
}

async function ensureSafeRuntimeDir(socketDir: string): Promise<void> {
  try {
    const stats = await fs.lstat(socketDir);
    if (stats.isSymbolicLink()) {
      throw new NodeIpcError(
        "Unix socket runtime directory must not be a symlink",
        "E_IPC_ADDRESS_INVALID",
      );
    }
    if (!stats.isDirectory()) {
      throw new NodeIpcError(
        "Unix socket runtime path is not a directory",
        "E_IPC_ADDRESS_INVALID",
      );
    }
    const isSticky = (stats.mode & 0o1000) !== 0;
    const isSafeSystemSticky = isSticky && stats.uid === 0;
    if (
      !isSafeSystemSticky &&
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new NodeIpcError(
        "Unix socket runtime directory is not owned by the current user",
        "E_IPC_ADDRESS_INVALID",
      );
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new NodeIpcError(
        "Unix socket runtime directory permissions are too broad",
        "E_IPC_ADDRESS_INVALID",
      );
    }
  } catch (cause) {
    if (cause instanceof NodeIpcError) throw cause;
    throw new NodeIpcError(
      "Could not secure Unix socket runtime directory",
      "E_IPC_ADDRESS_INVALID",
      cause,
    );
  }
}

async function ensureSafeRuntimeParents(socketDir: string): Promise<void> {
  const parsed = path.parse(socketDir);
  let current = parsed.root;
  const segments = path.relative(parsed.root, socketDir).split(path.sep);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new NodeIpcError(
        "Could not inspect Unix socket runtime directory",
        "E_IPC_ADDRESS_INVALID",
        cause,
      );
    }
    if (stats.isSymbolicLink()) {
      throw new NodeIpcError(
        "Unix socket runtime directory must not contain symlinks",
        "E_IPC_ADDRESS_INVALID",
      );
    }
    if (!stats.isDirectory()) {
      throw new NodeIpcError(
        "Unix socket runtime path is not a directory",
        "E_IPC_ADDRESS_INVALID",
      );
    }
    const isSticky = (stats.mode & 0o1000) !== 0;
    const isSafeSystemSticky = isSticky && stats.uid === 0;
    const isRootOwnedSystemAncestor =
      stats.uid === 0 && (stats.mode & 0o002) === 0;
    if (
      !isRootOwnedSystemAncestor &&
      !isSafeSystemSticky &&
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new NodeIpcError(
        "Unix socket runtime directory is not owned by the current user",
        "E_IPC_ADDRESS_INVALID",
      );
    }
    if (
      !isRootOwnedSystemAncestor &&
      !isSafeSystemSticky &&
      (stats.mode & 0o022) !== 0
    ) {
      throw new NodeIpcError(
        "Unix socket runtime directory permissions are too broad",
        "E_IPC_ADDRESS_INVALID",
      );
    }
  }

  try {
    const stats = await fs.lstat(socketDir);
    if (stats.isSymbolicLink()) {
      throw new NodeIpcError(
        "Unix socket runtime directory must not contain symlinks",
        "E_IPC_ADDRESS_INVALID",
      );
    }
    if (!stats.isDirectory()) {
      throw new NodeIpcError(
        "Unix socket runtime path is not a directory",
        "E_IPC_ADDRESS_INVALID",
      );
    }
  } catch (cause) {
    if (cause instanceof NodeIpcError) throw cause;
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new NodeIpcError(
        "Could not inspect Unix socket runtime directory",
        "E_IPC_ADDRESS_INVALID",
        cause,
      );
    }
  }
}

async function wrapCleanupError<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await promise;
  } catch (cause) {
    throw toNodeIpcError(cause, "E_IPC_STALE_SOCKET_CLEANUP_FAILED", message);
  }
}

function toNodeIpcError(
  cause: unknown,
  code: "E_IPC_CONNECT_FAILED" | "E_IPC_STALE_SOCKET_CLEANUP_FAILED",
  message = "Could not listen on Unix socket",
): NodeIpcError {
  if (cause instanceof NodeIpcError) return cause;
  return new NodeIpcError(message, code, cause);
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(false);
      else
        reject(
          new NodeIpcError(
            "Could not probe existing socket",
            "E_IPC_ADDRESS_INVALID",
            error,
          ),
        );
    });
  });
}

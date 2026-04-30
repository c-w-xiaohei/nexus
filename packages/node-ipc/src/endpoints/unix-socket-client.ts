import net from "node:net";
import type { IEndpoint } from "@nexus-js/core";
import { NodeIpcError } from "../errors";
import { UnixSocketPort } from "../ports/unix-socket-port";
import { NodeIpcAddress, type NodeIpcAddressResolver } from "../types/address";
import type { NodeIpcPlatformMeta, NodeIpcUserMeta } from "../types/meta";

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

export class UnixSocketClientEndpoint implements IEndpoint<
  NodeIpcUserMeta,
  NodeIpcPlatformMeta
> {
  readonly capabilities = createCapabilities();

  constructor(
    private readonly resolveAddress?: NodeIpcAddressResolver,
    private readonly authToken?: string,
    private readonly options: {
      authTimeoutMs?: number;
      maxAuthLineBytes?: number;
    } = {},
  ) {
    validateAuthToken(authToken);
  }

  async connect(
    targetDescriptor: Partial<NodeIpcUserMeta>,
  ): Promise<[UnixSocketPort, NodeIpcPlatformMeta]> {
    validateAuthToken(this.authToken);
    const address = NodeIpcAddress.resolve(
      targetDescriptor,
      this.resolveAddress,
    ).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
    if (address.kind !== "path")
      throw new NodeIpcError(
        "Abstract sockets are reserved but not implemented",
        "E_IPC_ADDRESS_INVALID",
      );

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const client = net.createConnection(address.path);
      client.once("connect", () => resolve(client));
      client.once("error", (cause) =>
        reject(
          new NodeIpcError(
            "Could not connect to Unix socket",
            "E_IPC_CONNECT_FAILED",
            cause,
          ),
        ),
      );
    });

    if (this.authToken !== undefined) {
      try {
        await writeAuthRequest(socket, this.authToken, this.options);
      } catch (error) {
        socket.destroy();
        throw error;
      }
    }

    return [
      new UnixSocketPort(socket),
      {
        socket: address,
        authenticated: this.authToken !== undefined,
        authMethod: this.authToken ? "shared-secret" : "none",
      },
    ];
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

function writeAuthRequest(
  socket: net.Socket,
  token: string,
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
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > maxAuthLineBytes) {
        finish(
          new NodeIpcError(
            "Auth response exceeded maximum line size",
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
            "Malformed auth response",
            "E_IPC_PROTOCOL_ERROR",
            cause,
          ),
        );
        return;
      }
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { type?: unknown }).type !== "nexus-ipc-auth-ok"
      ) {
        finish(
          new NodeIpcError("Malformed auth response", "E_IPC_PROTOCOL_ERROR"),
        );
        return;
      }
      finish();
    };
    const onError = (cause: Error) =>
      finish(
        new NodeIpcError(
          "IPC authentication failed",
          "E_IPC_AUTH_FAILED",
          cause,
        ),
      );
    const onClose = () =>
      finish(
        new NodeIpcError("IPC authentication failed", "E_IPC_AUTH_FAILED"),
      );
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(
      JSON.stringify({ type: "nexus-ipc-auth", version: 1, token }) + "\n",
    );
  });
}

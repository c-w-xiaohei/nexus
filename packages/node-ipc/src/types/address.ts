import os from "node:os";
import path from "node:path";
import { err, ok, Result } from "neverthrow";
import { NodeIpcError } from "../errors";
import type { NodeIpcUserMeta } from "./meta";

export type NodeIpcSocketAddress =
  | { kind: "path"; path: string }
  | { kind: "abstract"; name: string };

export type NodeIpcAddressResolver = (
  descriptor: Partial<NodeIpcUserMeta>,
) => NodeIpcSocketAddress | null;

type ResolveEnvironment = {
  env?: Record<string, string | undefined>;
  uid?: number;
};

const MAX_UNIX_SOCKET_PATH_LENGTH = 107;

export namespace NodeIpcAddress {
  export const defaultResolve = (
    descriptor: Partial<NodeIpcUserMeta>,
    environment: ResolveEnvironment = {},
  ): Result<NodeIpcSocketAddress, NodeIpcError> => {
    if (descriptor.context !== "node-ipc-daemon" || !descriptor.appId) {
      return err(
        new NodeIpcError(
          "Descriptor does not identify a node-ipc daemon",
          "E_IPC_ADDRESS_INVALID",
        ),
      );
    }

    const env = environment.env ?? process.env;
    const uid =
      environment.uid ??
      (typeof process.getuid === "function"
        ? process.getuid()
        : os.userInfo().uid);
    const root = env.XDG_RUNTIME_DIR
      ? path.join(env.XDG_RUNTIME_DIR, "nexus")
      : path.join("/tmp", `nexus-${uid}`);
    const segmentResult = validateSegment(descriptor.appId).andThen((appId) =>
      validateSegment(descriptor.instance ?? "default").map((instance) => ({
        appId,
        instance,
      })),
    );
    if (segmentResult.isErr()) return err(segmentResult.error);
    const { appId, instance } = segmentResult.value;

    return validate({
      kind: "path",
      path: path.join(root, appId, `${instance}.sock`),
    });
  };

  export const resolve = (
    descriptor: Partial<NodeIpcUserMeta>,
    resolver?: NodeIpcAddressResolver,
  ): Result<NodeIpcSocketAddress, NodeIpcError> => {
    if (!resolver) return defaultResolve(descriptor);

    try {
      const address = resolver(descriptor);
      if (!address)
        return err(
          new NodeIpcError(
            "Descriptor could not be resolved to a socket address",
            "E_IPC_ADDRESS_INVALID",
          ),
        );
      return validate(address);
    } catch (cause) {
      return err(
        new NodeIpcError(
          "Descriptor could not be resolved to a socket address",
          "E_IPC_ADDRESS_INVALID",
          cause,
        ),
      );
    }
  };

  export const validate = (
    address: NodeIpcSocketAddress,
  ): Result<NodeIpcSocketAddress, NodeIpcError> => {
    if (address.kind === "abstract") return ok(address);
    if (!path.isAbsolute(address.path)) {
      return err(
        new NodeIpcError(
          `Unix socket path must be absolute: ${address.path}`,
          "E_IPC_ADDRESS_INVALID",
        ),
      );
    }
    if (address.path.length > MAX_UNIX_SOCKET_PATH_LENGTH) {
      return err(
        new NodeIpcError(
          `Unix socket path is too long: ${address.path}`,
          "E_IPC_PATH_TOO_LONG",
        ),
      );
    }
    return ok(address);
  };
}

const validateSegment = (segment: string): Result<string, NodeIpcError> => {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes(path.win32.sep)
  ) {
    return err(
      new NodeIpcError(
        `Unix socket path segment is unsafe: ${segment}`,
        "E_IPC_ADDRESS_INVALID",
      ),
    );
  }

  return ok(segment);
};

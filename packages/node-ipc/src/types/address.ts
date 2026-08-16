import os from "node:os";
import path from "node:path";
import { Result } from "better-result";
const { err, ok } = Result;
import { NodeIpcError } from "../errors.js";
import type { NodeIpcConnectionTarget } from "./meta.js";

export type NodeIpcSocketAddress =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "abstract"; readonly name: string };

export type NodeIpcAddressResolver = (
  target: NodeIpcConnectionTarget,
) => NodeIpcSocketAddress | null;

type ResolveEnvironment = {
  env?: Record<string, string | undefined>;
  uid?: number;
};

const MAX_UNIX_SOCKET_PATH_LENGTH = 107;

export namespace NodeIpcAddress {
  export const defaultResolve = (
    target: NodeIpcConnectionTarget,
    environment: ResolveEnvironment = {},
  ): Result<NodeIpcSocketAddress, NodeIpcError> => {
    if (target.context !== "node-ipc-daemon" || !target.appId) {
      return err(
        new NodeIpcError(
          "Target does not identify a node-ipc daemon",
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
    const segmentResult = validateSegment(target.appId).andThen((appId) =>
      validateSegment(target.instance ?? "default").map((instance) => ({
        appId,
        instance,
      })),
    );
    if (segmentResult.isErr()) return err(segmentResult.error);
    const { appId, instance } = segmentResult.value;

    return validate({
      kind: "path",
      path: path.join(root, appId, `${instance}.sock`),
    }).map(normalize);
  };

  export const resolve = (
    target: NodeIpcConnectionTarget,
    resolver?: NodeIpcAddressResolver,
  ): Result<NodeIpcSocketAddress, NodeIpcError> => {
    if (target.context !== "node-ipc-daemon" || !target.appId) {
      return err(
        new NodeIpcError(
          "Target does not identify a node-ipc daemon",
          "E_IPC_ADDRESS_INVALID",
        ),
      );
    }
    if (!resolver) return defaultResolve(target);

    try {
      const address = resolver(target);
      if (!address)
        return err(
          new NodeIpcError(
            "Target could not be resolved to a socket address",
            "E_IPC_ADDRESS_INVALID",
          ),
        );
      return validate(address).map(normalize);
    } catch (cause) {
      return err(
        new NodeIpcError(
          "Target could not be resolved to a socket address",
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

  export const normalize = (
    address: NodeIpcSocketAddress,
  ): NodeIpcSocketAddress =>
    address.kind === "path"
      ? { kind: "path", path: path.normalize(address.path) }
      : { kind: "abstract", name: address.name };

  export const freeze = (address: NodeIpcSocketAddress): NodeIpcSocketAddress =>
    Object.freeze(normalize(address));
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

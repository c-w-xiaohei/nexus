import { nexus, type NexusConfig, type NexusInstance } from "@nexus-js/core";
import { UnixSocketClientEndpoint } from "./endpoints/unix-socket-client.js";
import { UnixSocketServerEndpoint } from "./endpoints/unix-socket-server.js";
import { NodeIpcAddress } from "./types/address.js";
import type { NodeIpcSocketAddress } from "./types/address.js";
import type {
  NodeIpcClientConfigOptions,
  NodeIpcClientOptions,
  NodeIpcDaemonConfigOptions,
  NodeIpcDaemonOptions,
} from "./types/options.js";
import type { NodeIpcAdapterModel } from "./types/meta.js";
import { NodeIpcError } from "./errors.js";

/** Configure or build a Node IPC daemon endpoint. */
export function usingNodeIpcDaemon(
  options: NodeIpcDaemonConfigOptions,
): NexusConfig<NodeIpcAdapterModel>;
export function usingNodeIpcDaemon(
  options: NodeIpcDaemonOptions,
): NexusInstance<NodeIpcAdapterModel>;
export function usingNodeIpcDaemon(
  options: NodeIpcDaemonOptions | NodeIpcDaemonConfigOptions,
) {
  const instance = options.instance ?? "default";
  const address = options.address
    ? validateDaemonAddress(options.address)
    : resolveDaemonAddress(options.appId, instance);
  validateAuthToken(options.authToken);
  const config: NexusConfig<NodeIpcAdapterModel> = {
    ...options,
    endpoint: {
      meta: {
        context: "node-ipc-daemon",
        appId: options.appId,
        instance,
        pid: process.pid,
      },
      implementation: new UnixSocketServerEndpoint(address, options.authToken, {
        authTimeoutMs: options.authTimeoutMs,
        maxAuthLineBytes: options.maxAuthLineBytes,
      }),
    },
  };

  return options.configure === false
    ? config
    : (nexus.configure(
        config as never,
      ) as unknown as NexusInstance<NodeIpcAdapterModel>);
}

/** Validate and normalize a daemon socket address before endpoint construction. */
function validateDaemonAddress(
  address: NodeIpcSocketAddress,
): NodeIpcSocketAddress {
  const result = NodeIpcAddress.validate(address);
  if (result.isErr()) throw result.error;
  return NodeIpcAddress.normalize(result.value);
}

/** Derive the default daemon socket address from its application identity. */
function resolveDaemonAddress(
  appId: string,
  instance: string,
): NodeIpcSocketAddress {
  const result = NodeIpcAddress.defaultResolve({
    context: "node-ipc-daemon",
    appId,
    instance,
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

/** Configure or build a Node IPC client endpoint. */
export function usingNodeIpcClient(
  options: NodeIpcClientConfigOptions,
): NexusConfig<NodeIpcAdapterModel>;
export function usingNodeIpcClient(
  options: NodeIpcClientOptions,
): NexusInstance<NodeIpcAdapterModel>;
export function usingNodeIpcClient(
  options: NodeIpcClientOptions | NodeIpcClientConfigOptions,
) {
  validateAuthToken(options.authToken);
  const { connectTo, ...configOptions } = options;
  const config: NexusConfig<NodeIpcAdapterModel> = {
    ...configOptions,
    endpoint: {
      meta: {
        context: "node-ipc-client",
        appId: options.appId,
        pid: process.pid,
      },
      implementation: new UnixSocketClientEndpoint(
        options.resolveAddress,
        options.authToken,
        {
          authTimeoutMs: options.authTimeoutMs,
          maxAuthLineBytes: options.maxAuthLineBytes,
        },
      ),
      ...(connectTo ? { connectTo } : {}),
    },
  };

  return options.configure === false
    ? config
    : (nexus.configure(
        config as never,
      ) as unknown as NexusInstance<NodeIpcAdapterModel>);
}

/** Reject an explicitly empty token before opening an IPC endpoint. */
function validateAuthToken(authToken: string | undefined): void {
  if (authToken === "") {
    throw new NodeIpcError(
      "IPC auth token must not be empty",
      "E_IPC_AUTH_FAILED",
    );
  }
}

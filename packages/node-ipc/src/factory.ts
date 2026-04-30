import { nexus, type NexusConfig, type NexusInstance } from "@nexus-js/core";
import { UnixSocketClientEndpoint } from "./endpoints/unix-socket-client";
import { UnixSocketServerEndpoint } from "./endpoints/unix-socket-server";
import { NodeIpcMatchers } from "./matchers";
import { NodeIpcAddress } from "./types/address";
import type { NodeIpcSocketAddress } from "./types/address";
import type {
  NodeIpcClientConfigOptions,
  NodeIpcClientOptions,
  NodeIpcDaemonConfigOptions,
  NodeIpcDaemonOptions,
} from "./types/options";
import type { NodeIpcPlatformMeta, NodeIpcUserMeta } from "./types/meta";
import { NodeIpcError } from "./errors";

export function usingNodeIpcDaemon(
  options: NodeIpcDaemonConfigOptions,
): NexusConfig<NodeIpcUserMeta, NodeIpcPlatformMeta>;
export function usingNodeIpcDaemon(
  options: NodeIpcDaemonOptions,
): NexusInstance<NodeIpcUserMeta, NodeIpcPlatformMeta>;
export function usingNodeIpcDaemon(
  options: NodeIpcDaemonOptions | NodeIpcDaemonConfigOptions,
) {
  const instance = options.instance ?? "default";
  const address = options.address
    ? validateDaemonAddress(options.address)
    : resolveDaemonAddress(options.appId, instance);
  validateAuthToken(options.authToken);
  const config: NexusConfig<NodeIpcUserMeta, NodeIpcPlatformMeta> = {
    ...options,
    endpoint: {
      meta: {
        context: "node-ipc-daemon",
        appId: options.appId,
        instance,
        pid: process.pid,
        groups: options.groups,
      },
      implementation: new UnixSocketServerEndpoint(address, options.authToken, {
        authTimeoutMs: options.authTimeoutMs,
        maxAuthLineBytes: options.maxAuthLineBytes,
      }),
    },
    matchers: baseMatchers(options.appId, options.groups, instance),
    descriptors: {
      daemon: { context: "node-ipc-daemon", appId: options.appId, instance },
    },
  };

  return options.configure === false ? config : nexus.configure(config);
}

function validateDaemonAddress(
  address: NodeIpcSocketAddress,
): NodeIpcSocketAddress {
  return NodeIpcAddress.validate(address).match(
    (validated) => validated,
    (error) => {
      throw error;
    },
  );
}

function resolveDaemonAddress(
  appId: string,
  instance: string,
): NodeIpcSocketAddress {
  return NodeIpcAddress.defaultResolve({
    context: "node-ipc-daemon",
    appId,
    instance,
  }).match(
    (address) => address,
    (error) => {
      throw error;
    },
  );
}

export function usingNodeIpcClient(
  options: NodeIpcClientConfigOptions,
): NexusConfig<NodeIpcUserMeta, NodeIpcPlatformMeta>;
export function usingNodeIpcClient(
  options: NodeIpcClientOptions,
): NexusInstance<NodeIpcUserMeta, NodeIpcPlatformMeta>;
export function usingNodeIpcClient(
  options: NodeIpcClientOptions | NodeIpcClientConfigOptions,
) {
  validateAuthToken(options.authToken);
  const config: NexusConfig<NodeIpcUserMeta, NodeIpcPlatformMeta> = {
    ...options,
    endpoint: {
      meta: {
        context: "node-ipc-client",
        appId: options.appId,
        pid: process.pid,
        groups: options.groups,
      },
      implementation: new UnixSocketClientEndpoint(
        options.resolveAddress,
        options.authToken,
        {
          authTimeoutMs: options.authTimeoutMs,
          maxAuthLineBytes: options.maxAuthLineBytes,
        },
      ),
      connectTo: options.connectTo,
    },
    matchers: baseMatchers(options.appId, options.groups),
    descriptors: {},
  };

  return options.configure === false ? config : nexus.configure(config);
}

function validateAuthToken(authToken: string | undefined): void {
  if (authToken === "") {
    throw new NodeIpcError(
      "IPC auth token must not be empty",
      "E_IPC_AUTH_FAILED",
    );
  }
}

function baseMatchers(appId: string, groups?: string[], instance?: string) {
  return {
    daemon: NodeIpcMatchers.daemon(appId),
    client: NodeIpcMatchers.client(appId),
    instance: NodeIpcMatchers.instance(instance ?? "default"),
    ...Object.fromEntries(
      (groups ?? []).map((name) => [name, NodeIpcMatchers.group(name)]),
    ),
  };
}

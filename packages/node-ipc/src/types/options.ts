import type { ConnectionTargetOf, NexusConfig } from "@nexus-js/core";
import type { TransportLimits } from "@nexus-js/core/transport/config";
import type {
  NodeIpcAddressResolver,
  NodeIpcSocketAddress,
} from "./address.js";
import type { NodeIpcAdapterModel } from "./meta.js";

export type NodeIpcDaemonOptions = {
  appId: string;
  instance?: string;
  address?: NodeIpcSocketAddress;
  authToken?: string;
  authTimeoutMs?: number;
  maxAuthLineBytes?: number;
  transport?: TransportLimits;
  configure?: true;
} & Omit<NexusConfig<NodeIpcAdapterModel>, "endpoint">;

export type NodeIpcDaemonConfigOptions = Omit<
  NodeIpcDaemonOptions,
  "configure"
> & {
  configure: false;
};

export type NodeIpcClientOptions = {
  appId: string;
  authToken?: string;
  authTimeoutMs?: number;
  maxAuthLineBytes?: number;
  transport?: TransportLimits;
  connectTo?: readonly ConnectionTargetOf<NodeIpcAdapterModel>[];
  resolveAddress?: NodeIpcAddressResolver;
  configure?: true;
} & Omit<NexusConfig<NodeIpcAdapterModel>, "endpoint">;

export type NodeIpcClientConfigOptions = Omit<
  NodeIpcClientOptions,
  "configure"
> & {
  configure: false;
};

import type { NexusConfig } from "@nexus-js/core";
import type {
  NodeIpcAddressResolver,
  NodeIpcSocketAddress,
} from "./address.js";
import type { NodeIpcAdapterModel, NodeIpcConnectionTarget } from "./meta.js";

export type NodeIpcDaemonOptions = {
  appId: string;
  instance?: string;
  groups?: string[];
  address?: NodeIpcSocketAddress;
  authToken?: string;
  authTimeoutMs?: number;
  maxAuthLineBytes?: number;
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
  groups?: string[];
  authToken?: string;
  authTimeoutMs?: number;
  maxAuthLineBytes?: number;
  defaultTarget?: NodeIpcConnectionTarget;
  resolveAddress?: NodeIpcAddressResolver;
  configure?: true;
} & Omit<NexusConfig<NodeIpcAdapterModel>, "endpoint">;

export type NodeIpcClientConfigOptions = Omit<
  NodeIpcClientOptions,
  "configure"
> & {
  configure: false;
};

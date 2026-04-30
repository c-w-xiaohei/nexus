import type { NexusConfig, TargetCriteria } from "@nexus-js/core";
import type { NodeIpcAddressResolver, NodeIpcSocketAddress } from "./address";
import type { NodeIpcPlatformMeta, NodeIpcUserMeta } from "./meta";

export type NodeIpcDaemonOptions = {
  appId: string;
  instance?: string;
  groups?: string[];
  address?: NodeIpcSocketAddress;
  authToken?: string;
  authTimeoutMs?: number;
  maxAuthLineBytes?: number;
  configure?: true;
} & Omit<
  NexusConfig<NodeIpcUserMeta, NodeIpcPlatformMeta>,
  "endpoint" | "matchers" | "descriptors"
>;

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
  connectTo?: readonly TargetCriteria<NodeIpcUserMeta, string, string>[];
  resolveAddress?: NodeIpcAddressResolver;
  configure?: true;
} & Omit<
  NexusConfig<NodeIpcUserMeta, NodeIpcPlatformMeta>,
  "endpoint" | "matchers" | "descriptors"
>;

export type NodeIpcClientConfigOptions = Omit<
  NodeIpcClientOptions,
  "configure"
> & {
  configure: false;
};

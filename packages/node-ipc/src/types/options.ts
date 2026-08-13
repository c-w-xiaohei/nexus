import type { NexusConfig, Target } from "@nexus-js/core";
import type {
  NodeIpcAddressResolver,
  NodeIpcSocketAddress,
} from "./address.js";
import type { NodeIpcPlatformMeta, NodeIpcEndpointMeta } from "./meta.js";

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
  NexusConfig<NodeIpcEndpointMeta, NodeIpcPlatformMeta>,
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
  connectTo?: readonly Target<NodeIpcEndpointMeta, string, string>[];
  resolveAddress?: NodeIpcAddressResolver;
  configure?: true;
} & Omit<
  NexusConfig<NodeIpcEndpointMeta, NodeIpcPlatformMeta>,
  "endpoint" | "matchers" | "descriptors"
>;

export type NodeIpcClientConfigOptions = Omit<
  NodeIpcClientOptions,
  "configure"
> & {
  configure: false;
};

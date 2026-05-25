import type { NodeIpcSocketAddress } from "./address";

export type NodeIpcDaemonMeta = {
  context: "node-ipc-daemon";
  appId: string;
  instance?: string;
  pid: number;
  groups?: string[];
};

export type NodeIpcClientMeta = {
  context: "node-ipc-client";
  appId: string;
  pid: number;
  groups?: string[];
};

export type NodeIpcEndpointMeta = NodeIpcDaemonMeta | NodeIpcClientMeta;

export type NodeIpcPlatformMeta = {
  socket: NodeIpcSocketAddress;
  authenticated: boolean;
  authMethod?: "none" | "shared-secret";
  pid?: number;
  uid?: number;
  gid?: number;
};

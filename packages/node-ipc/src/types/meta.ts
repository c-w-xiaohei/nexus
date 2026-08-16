import type { NodeIpcSocketAddress } from "./address.js";
import type { AdapterModel } from "@nexus-js/core";

export type NodeIpcDaemonMeta = {
  readonly context: "node-ipc-daemon";
  readonly appId: string;
  readonly instance?: string;
  readonly pid: number;
  readonly groups?: readonly string[];
};

export type NodeIpcClientMeta = {
  readonly context: "node-ipc-client";
  readonly appId: string;
  readonly pid: number;
  readonly groups?: readonly string[];
};

export type NodeIpcContextMeta = NodeIpcDaemonMeta | NodeIpcClientMeta;

export type NodeIpcConnectionTarget = {
  readonly context: "node-ipc-daemon";
  readonly appId: string;
  readonly instance?: string;
};

export type NodeIpcObservedConnectionFacts = {
  readonly socket: NodeIpcSocketAddress;
  readonly authenticated: boolean;
  readonly authMethod?: "none" | "shared-secret";
  readonly pid?: number;
  readonly uid?: number;
  readonly gid?: number;
};

export type NodeIpcConnectionMeta = {
  /** The target selected by a client before opening this connection. */
  readonly selected?: NodeIpcConnectionTarget;
  /** The socket address resolved from the selected target. */
  readonly resolved?: NodeIpcSocketAddress;
  /** Facts observed from the live socket and pre-auth exchange. */
  readonly observed: NodeIpcObservedConnectionFacts;
};

export interface NodeIpcAdapterModel extends AdapterModel {
  contextMeta: NodeIpcContextMeta;
  connectionMeta: NodeIpcConnectionMeta;
  connectionTarget: NodeIpcConnectionTarget;
}

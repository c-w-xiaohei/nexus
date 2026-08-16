import type { ConnectionWhere } from "@nexus-js/core";
import type {
  NodeIpcAdapterModel,
  NodeIpcConnectionMeta,
  NodeIpcConnectionTarget,
  NodeIpcContextMeta,
} from "./types/meta";

const contextMeta: NodeIpcContextMeta = {
  context: "node-ipc-daemon",
  appId: "daemon",
  pid: 1,
};

const connectionTarget: NodeIpcConnectionTarget = {
  context: "node-ipc-daemon",
  appId: "daemon",
};

const connectionMeta: NodeIpcConnectionMeta = {
  observed: {
    socket: { kind: "path", path: "/tmp/daemon.sock" },
    authenticated: false,
  },
};

const where: ConnectionWhere<NodeIpcAdapterModel> = (
  remoteContext,
  localConnection,
) =>
  remoteContext.context === "node-ipc-daemon" &&
  !localConnection.observed.authenticated;

void contextMeta;
void connectionTarget;
void connectionMeta;
void where;

import type { NodeIpcEndpointMeta } from "./types/meta";

export const NodeIpcMatchers = {
  daemon: (appId: string) => (identity: NodeIpcEndpointMeta) =>
    identity.context === "node-ipc-daemon" && identity.appId === appId,
  client: (appId: string) => (identity: NodeIpcEndpointMeta) =>
    identity.context === "node-ipc-client" && identity.appId === appId,
  instance: (name: string) => (identity: NodeIpcEndpointMeta) =>
    identity.context === "node-ipc-daemon" &&
    (identity.instance ?? "default") === name,
  group: (name: string) => (identity: NodeIpcEndpointMeta) =>
    identity.groups?.includes(name) === true,
};

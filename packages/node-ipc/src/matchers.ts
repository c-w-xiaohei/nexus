import type { NodeIpcUserMeta } from "./types/meta";

export const NodeIpcMatchers = {
  daemon: (appId: string) => (identity: NodeIpcUserMeta) =>
    identity.context === "node-ipc-daemon" && identity.appId === appId,
  client: (appId: string) => (identity: NodeIpcUserMeta) =>
    identity.context === "node-ipc-client" && identity.appId === appId,
  instance: (name: string) => (identity: NodeIpcUserMeta) =>
    identity.context === "node-ipc-daemon" &&
    (identity.instance ?? "default") === name,
  group: (name: string) => (identity: NodeIpcUserMeta) =>
    identity.groups?.includes(name) === true,
};

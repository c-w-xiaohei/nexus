export { Nexus, nexus } from "./api/nexus";
export type {
  NexusCallError,
  ResourceAcquireError,
  ConnectionAcquireError,
} from "./errors";
export { ConnectionCollection } from "./api/connection";
export type { Connection } from "./api/connection";
export type {
  ConnectionResource,
  DisconnectReason,
  ResourceOptions,
} from "./api/connection";
export type {
  ConnectOptions,
  ConnectMulticastOptions,
} from "./api/types/config";

export { Expose } from "./api/decorators/expose";
export { Endpoint } from "./api/decorators/endpoint";

export { Token } from "./api/token";
export { TokenSpace } from "./api/token-space";
export {
  serviceProvider,
  defineNexusConfig,
  composeNexusConfig,
} from "./api/types/config";
export type { TokenSpaceConfig } from "./api/token-space";

export type {
  ContextMeta,
  ConnectionMeta,
  ConnectionTarget,
  ConnectionContext,
} from "./types/identity";
export type {
  AdapterModel,
  DefaultAdapterModel,
  ContextMetaOf,
  ConnectionMetaOf,
  ConnectionTargetOf,
  ConnectionWhere,
} from "./types/adapter-model";
export type { IPort, IEndpoint } from "@/transport";
export type {
  NexusConfig,
  NexusAuthorizationPolicy,
  ConnectionAuthContext,
  EndpointConfig,
  ServiceProvider,
  AuthorizationPolicy,
  ServiceCallAuthContext,
} from "./api/types/config"; // 配置和寻址相关类型
export type {
  NexusInstance,
  Asyncified,
  Remote,
  RemoteValue,
  TokenService,
} from "./api/types"; // Nexus 实例和代理相关类型
export type { RefWrapper } from "./types/ref-wrapper";
export type {
  ProxyDebugSnapshot,
  ProxyStatus,
} from "./service/proxy-lifecycle";
// 错误类
export {
  NexusError,
  NexusConnectionError,
  NexusConnectionConstraintFailedError,
  NexusProtocolIncompatibleError,
  NexusRemoteError,
  NexusResourceError,
  NexusUsageError,
  NexusHandshakeError,
  NexusTransportError,
  NexusEndpointConnectError,
  NexusEndpointListenError,
  NexusEndpointCapabilityError,
  NexusProtocolError,
  NexusServiceError,
  NexusDisconnectedError,
} from "./errors";

export { configureNexusLogger, LogLevel } from "./logger";

export { Nexus, nexus } from "./api/nexus";

export { Expose } from "./api/decorators/expose";
export { Endpoint } from "./api/decorators/endpoint";

export { Token } from "./api/token";
export type { TokenOptions } from "./api/token";
export { TokenSpace } from "./api/token-space";
export {
  serviceProvider,
  defineNexusConfig,
  composeNexusConfig,
} from "./api/types/config";
export type {
  TokenSpaceConfig,
  TokenSpaceDefaultTarget,
  ChildTokenSpaceConfig,
} from "./api/token-space";

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
  CreateOptions,
  CreateMulticastOptions,
  SelectOptions,
  SelectMulticastOptions,
} from "./api/types/config"; // 配置和寻址相关类型
export type {
  NexusInstance,
  Asyncified,
  Allified,
  Streamified,
  RuntimeCreateTokenParam,
  TokenService,
} from "./api/types"; // Nexus 实例和代理相关类型
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
  NexusTargetingError,
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

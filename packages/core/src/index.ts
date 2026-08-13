export { Nexus, nexus } from "./api/nexus.js";

export { Expose } from "./api/decorators/expose.js";
export { Endpoint } from "./api/decorators/endpoint.js";

export { Token } from "./api/token.js";
export type { TokenOptions } from "./api/token.js";
export { TokenSpace } from "./api/token-space.js";
export {
  serviceProvider,
  defineNexusConfig,
  composeNexusConfig,
} from "./api/types/config.js";
export type {
  TokenSpaceConfig,
  TokenSpaceDefaultTarget,
  ChildTokenSpaceConfig,
} from "./api/token-space.js";

export type {
  EndpointMeta,
  PlatformMeta,
  ConnectionContext,
} from "./types/identity.js";
export type { IPort, IEndpoint } from "./transport/index.js";
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
  Target,
  InlineTarget,
  MulticastTarget,
  DescriptorTarget,
  MatcherTarget,
  MessageTarget,
} from "./api/types/config.js"; // 配置和寻址相关类型
export type {
  NexusInstance,
  MatcherUtils,
  Asyncified,
  Allified,
  Streamified,
  RuntimeCreateToken,
  RuntimeCreateTokenParam,
  TokenService,
} from "./api/types/index.js"; // Nexus 实例和代理相关类型
// 错误类
export {
  NexusError,
  NexusConnectionError,
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
} from "./errors/index.js";

export { configureNexusLogger, LogLevel } from "./logger.js";

export { Nexus, nexus } from "./api/nexus";

export { Expose } from "./api/decorators/expose";
export { Endpoint } from "./api/decorators/endpoint";

export { Token } from "./api/token";
export { TokenSpace } from "./api/token-space";
export type {
  TokenSpaceConfig,
  TokenSpaceDefaultTarget,
  ChildTokenSpaceConfig,
} from "./api/token-space";

export type {
  UserMetadata,
  PlatformMetadata,
  ConnectionContext,
} from "./types/identity";
export type { IPort, IEndpoint } from "@/transport";
export type {
  NexusConfig,
  EndpointConfig,
  ServiceRegistration,
  AuthorizationPolicy,
  CreateOptions,
  CreateMulticastOptions,
  TargetCriteria,
  TargetDescriptor,
  TargetMatcher,
  MessageTarget,
} from "./api/types/config"; // 配置和寻址相关类型
export type {
  NexusInstance,
  MatcherUtils,
  Asyncified,
  Allified,
  Streamified,
} from "./api/types"; // Nexus 实例和代理相关类型

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
} from "./errors";

export { configureNexusLogger, LogLevel } from "./logger";

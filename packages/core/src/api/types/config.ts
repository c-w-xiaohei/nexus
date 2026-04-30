import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import type { IEndpoint } from "@/transport";
import type { Token } from "../token";

/**
 * Describes the criteria for finding an endpoint, used for unicast targets.
 */
export interface TargetCriteria<
  U extends UserMetadata,
  M extends string,
  D extends string,
> {
  descriptor?: TargetDescriptor<U, D>;
  matcher?: TargetMatcher<U, M>;
}

/**
 * Describes the criteria for finding endpoints, used for multicast targets.
 */
export interface MulticastTargetCriteria<
  U extends UserMetadata,
  M extends string,
  D extends string,
> extends TargetCriteria<U, M, D> {
  /** (可选) 指定一个预定义的服务组名称 */
  groupName?: string;
}

/**
 * 连接目标的描述符。
 * 它可以是预先注册的命名描述符（字符串），也可以是内联的元数据部分对象。
 */
export type TargetDescriptor<
  U,
  RegisteredDescriptors extends string = string,
> = Partial<U> | RegisteredDescriptors;

/**
 * 连接目标的匹配器。
 * 它可以是预先注册的命名匹配器（字符串），也可以是内联的谓词函数。
 */
export type TargetMatcher<U, M extends string> = M | ((identity: U) => boolean);

/**
 * 定义一个消息的目标。
 * 这是 L4 中用于指定 `create` 方法寻址的核心类型。
 */
export interface MessageTarget<
  U extends UserMetadata,
  RegisteredMatchers extends string = string,
  RegisteredDescriptors extends string = string,
> {
  /** (可选) 直接指定一个连接ID */
  connectionId?: string;
  /** (可选) 指定一个预定义的服务组名称 */
  groupName?: string;
  /** (可选) 使用匹配器在现有连接中查找 */
  matcher?: TargetMatcher<U, RegisteredMatchers>;
  /** (可选) 当找不到连接时，用于发起新连接的蓝图 */
  descriptor?: TargetDescriptor<U, RegisteredDescriptors>;
}

/**
 * Options for creating a unicast service proxy (`nexus.create`).
 */
export interface CreateOptions<
  U extends UserMetadata,
  M extends string,
  D extends string,
> {
  /** The criteria for finding the target endpoint. */
  target: TargetCriteria<U, M, D>;
  /**
   * The expected number of results.
   * - 'one': Expects exactly one connection. Throws if 0 or >1 are found. (Default)
   * - 'first': Expects at least one connection, uses the first one found.
   */
  expects?: "one" | "first";
  /** A timeout in milliseconds for the call. */
  timeout?: number;
}

/**
 * Options for creating a multicast service proxy (`nexus.createMulticast`).
 */
export interface CreateMulticastOptions<
  U extends UserMetadata,
  E extends "all" | "stream",
  M extends string,
  D extends string,
> {
  /** The criteria for finding the target endpoint(s). */
  target: MulticastTargetCriteria<U, M, D>;
  /**
   * The expected multicast strategy.
   * - 'all': Collect results from all matching connections. (Default)
   * - 'stream': Receive results from all matching connections as a stream.
   */
  expects?: E;
  /** A timeout in milliseconds for the call. */
  timeout?: number;
}

/**
 * 定义一个端点的配置。
 */
export interface EndpointConfig<
  U extends UserMetadata,
  P extends PlatformMetadata,
  _RegisteredMatchers extends string = string,
  _RegisteredDescriptors extends string = string,
> {
  /** 当前端点的业务身份 */
  meta: U;
  /**
   * （仅在首次配置时需要）L1 的平台适配器实例。
   * @see IEndpoint
   */
  implementation?: IEndpoint<U, P>;
  /**
   * （可选）声明此端点在初始化时应主动连接的目标。
   */
  connectTo?: readonly TargetCriteria<
    U,
    _RegisteredMatchers,
    _RegisteredDescriptors
  >[];
}

/**
 * 授权策略，用于精细化控制连接和调用权限。
 * @template U 用户元数据类型
 */
export interface ConnectionAuthContext<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  readonly localIdentity: U;
  readonly remoteIdentity: U;
  readonly platform: P;
  readonly direction: "incoming" | "outgoing";
}

export interface ServiceCallAuthContext<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  readonly localIdentity: U;
  readonly remoteIdentity: U;
  readonly platform: P;
  readonly connectionId: string;
  readonly serviceName: string;
  readonly path: (string | number)[];
  readonly operation: "GET" | "SET" | "APPLY";
}

export interface NexusAuthorizationPolicy<
  U extends UserMetadata,
  P extends PlatformMetadata = PlatformMetadata,
> {
  canConnect?(context: ConnectionAuthContext<U, P>): boolean | Promise<boolean>;
  canCall?(context: ServiceCallAuthContext<U, P>): boolean | Promise<boolean>;
}

export type AuthorizationPolicy<
  U extends UserMetadata,
  P extends PlatformMetadata = PlatformMetadata,
> = NexusAuthorizationPolicy<U, P>;

/**
 * 编程式服务注册的配置项。
 * @template T 服务的接口类型
 */
export interface ServiceRegistration<
  T,
  U extends UserMetadata = UserMetadata,
  P extends PlatformMetadata = PlatformMetadata,
> {
  /**
   * 标识服务的 Token。
   */
  token: Token<T>;

  /**
   * 服务的具体实现实例。
   */
  implementation: T;

  /**
   * （可选）为此服务指定一个独立的授权策略。
   */
  policy?: AuthorizationPolicy<U, P>;
}

/**
 * Nexus 框架的统一配置对象。
 * @template U 用户元数据类型
 * @template P 平台元数据类型
 */
export interface NexusConfig<
  U extends UserMetadata,
  P extends PlatformMetadata,
  _RegisteredMatchers extends string = string,
  _RegisteredDescriptors extends string = string,
> {
  /**
   * （可选）配置当前端点的身份和连接行为。
   * 在首次配置时，`meta` 和 `implementation` 都是必需的。
   */
  endpoint?: EndpointConfig<U, P, _RegisteredMatchers, _RegisteredDescriptors>;
  /**
   * （可选）注册 L1 的平台适配器实例。
   * @deprecated 请使用 `endpoint.implementation`
   */
  implementation?: IEndpoint<U, P>;

  /**
   * （可选）编程式注册服务列表。
   * @see ServiceRegistration
   */
  services?: ServiceRegistration<object, U, P>[];

  /**
   * （可选）注册命名匹配器，用于在 `create` 方法中复用。
   * Key 是匹配器的名称，Value 是匹配器函数。
   */
  matchers?: Record<string, (identity: U) => boolean>;

  /**
   * （可选）注册命名寻址描述符，用于在 `create` 或 `connectTo` 中复用。
   * Key 是描述符的名称，Value 是描述符对象。
   */
  descriptors?: Record<string, Partial<U>>;

  /**
   * （可选）定义全局的授权策略。
   */
  policy?: NexusAuthorizationPolicy<U, P>;
}

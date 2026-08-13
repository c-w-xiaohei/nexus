import type { EndpointMeta, PlatformMeta } from "../../types/identity.js";
import type { RefWrapper } from "../../types/ref-wrapper.js";
import type { Token } from "../token.js";
import type {
  NexusConfig,
  ServiceProvider,
  AuthorizationPolicy,
  CreateOptions,
  MatcherTarget,
  CreateMulticastOptions,
} from "./config.js";
import type {
  ExposeOptions,
  NexusClassDecorator,
} from "../decorators/expose.js";
import type {
  EndpointOptions,
  NexusEndpointDecorator,
} from "../decorators/endpoint.js";
import type { SerializedError } from "../../types/message.js";
import type { Result } from "better-result";

// 类型工具，用于从配置对象中提取匹配器和描述符的名称
export type GetMatchers<T> = T extends { matchers: infer M }
  ? keyof M & string
  : never;

export type GetDescriptors<T> = T extends { descriptors: infer D }
  ? keyof D & string
  : never;

type IsAny<T> = 0 extends 1 & T ? true : false;

export type TokenEndpointMeta<TToken> =
  TToken extends Token<infer _T, infer U> ? U : never;

type TokenEndpointMetaProperty<TToken> = TToken extends {
  readonly __metadata?: infer U;
}
  ? NonNullable<U>
  : never;

export type TokenService<TToken> =
  TToken extends Token<infer T, infer _U> ? T : never;

export type RuntimeCreateMetadata<
  U extends EndpointMeta,
  TokenU extends EndpointMeta,
> =
  IsAny<TokenU> extends true
    ? never
    : U extends TokenU
      ? TokenU
      : EndpointMeta extends TokenU
        ? TokenU
        : never;

export type RuntimeCreateMetadataCheck<
  U extends EndpointMeta,
  TokenU extends EndpointMeta,
> = RuntimeCreateMetadata<U, TokenU> extends never ? [token: never] : [];

export type RuntimeCreateToken<
  U extends EndpointMeta,
  TToken extends Token<any, any>,
> =
  IsAny<TokenEndpointMetaProperty<TToken>> extends true
    ? never
    : U extends TokenEndpointMetaProperty<TToken>
      ? TToken
      : EndpointMeta extends TokenEndpointMetaProperty<TToken>
        ? TToken
        : never;

export type RuntimeCreateTokenCheck<
  U extends EndpointMeta,
  TToken extends Token<any, any>,
> = RuntimeCreateToken<U, TToken> extends never ? [token: never] : [];

export type RuntimeCreateArgs<
  U extends EndpointMeta,
  TToken extends Token<any, any>,
  O,
> =
  RuntimeCreateToken<U, TToken> extends never
    ? [token: never, options?: O]
    : [token: TToken, options?: O];

export type RuntimeCreateTokenParam<T extends object, U extends EndpointMeta> =
  | Token<T, U>
  | Token<T>;

/**
 * A Nexus-specific version of the standard `PromiseSettledResult`.
 * It provides a typed `reason` for rejected promises.
 */
export type NexusPromiseSettledResult<T> =
  | {
      status: "fulfilled";
      value: T;
      from: string; // connectionId
    }
  | {
      status: "rejected";
      reason: SerializedError; // Typed reason
      from: string; // connectionId
    };

/** A helper type to safely unwrap a Promise. */
type Unwrapped<T> = T extends Promise<infer U> ? U : T;

/**
 * A utility type that recursively converts function return types in an object `T` to Promises.
 * This version is simplified and corrects a bug where existing Promises on properties were double-wrapped.
 */
export type Asyncified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Unwrapped<R>> // Handles all functions
    : Promise<Unwrapped<T[K]>>; // Handles all properties
};

/**
 * A utility type for the 'all' strategy.
 * This version is simplified and corrects a bug with double-wrapped Promises.
 */
export type Allified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<NexusPromiseSettledResult<Unwrapped<R>>[]>
    : Promise<NexusPromiseSettledResult<Unwrapped<T[K]>>[]>;
};

/**
 * A utility type for the 'stream' strategy.
 * This version is simplified and corrects a bug with double-wrapped Promises.
 */
export type Streamified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (
        ...args: A
      ) => Promise<AsyncIterable<NexusPromiseSettledResult<Unwrapped<R>>>>
    : Promise<AsyncIterable<NexusPromiseSettledResult<Unwrapped<T[K]>>>>;
};

/**
 * The public-facing Nexus instance API.
 * This interface evolves its generics as `configure` is called.
 */
export interface NexusInstance<
  U extends EndpointMeta = any,
  P extends PlatformMeta = any,
  RegisteredMatchers extends string = never,
  RegisteredDescriptors extends string = never,
> {
  // Configuration
  safeConfigure<const T extends NexusConfig<U, P>>(
    config: T,
  ): Result<
    NexusInstance<
      U,
      P,
      RegisteredMatchers | GetMatchers<T>,
      RegisteredDescriptors | GetDescriptors<T>
    >,
    Error
  >;

  configure<const T extends NexusConfig<U, P>>(
    config: T,
  ): NexusInstance<
    U,
    P,
    RegisteredMatchers | GetMatchers<T>,
    RegisteredDescriptors | GetDescriptors<T>
  >;

  provide<T extends object>(
    token: Token<T, any>,
    service: T,
    options?: { policy?: AuthorizationPolicy<U, P> },
  ): this;
  provide<T extends object>(registration: ServiceProvider<T, U, P>): this;
  provide(registrations: readonly ServiceProvider<object, U, P>[]): this;

  safeProvide<T extends object>(
    token: Token<T, any>,
    service: T,
    options?: { policy?: AuthorizationPolicy<U, P> },
  ): Result<this, Error>;
  safeProvide<T extends object>(
    registration: ServiceProvider<T, U, P>,
  ): Result<this, Error>;
  safeProvide(
    registrations: readonly ServiceProvider<object, U, P>[],
  ): Result<this, Error>;

  ready(): Promise<void>;
  safeReady(): Promise<Result<void, Error>>;

  /**
   * Creates a proxy for a single remote service.
   * This method performs immediate connection resolution and will fail fast
   * if a unique, suitable connection cannot be established.
   *
   * @param token The service token identifying the contract.
   * @param options The options for creating the proxy.
   * @returns A promise that resolves to the service proxy.
   * @throws {NexusTargetingError} If a unique connection cannot be found.
   */
  create<T extends object>(
    token: RuntimeCreateTokenParam<T, U>,
    options?: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>,
  ): Promise<Asyncified<T>>;

  safeCreate<T extends object>(
    token: RuntimeCreateTokenParam<T, U>,
    options?: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>,
  ): Promise<Result<Asyncified<T>, Error>>;

  /**
   * Creates a multicast proxy to interact with multiple remote services simultaneously.
   * This method does not fail if no connections are found; it will instead
   * return an empty array or an empty async iterator.
   *
   * @param token The service token identifying the contract.
   * @param options The options for creating the multicast proxy.
   * @returns A promise that resolves to a multicast proxy.
   */
  createMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "all",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(
    token: RuntimeCreateTokenParam<T, U>,
    options?: O,
  ): Promise<Allified<T>>;

  createMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "stream",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(
    token: RuntimeCreateTokenParam<T, U>,
    options?: O,
  ): Promise<Streamified<T>>;

  safeCreateMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "all",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(
    token: RuntimeCreateTokenParam<T, U>,
    options?: O,
  ): Promise<Result<Allified<T>, Error>>;

  safeCreateMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "stream",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(
    token: RuntimeCreateTokenParam<T, U>,
    options?: O,
  ): Promise<Result<Streamified<T>, Error>>;

  /**
   * Updates the identity of the current endpoint.
   * @param updates A partial object of the user metadata to update.
   */
  updateIdentity(updates: Partial<U>): Promise<void>;
  safeUpdateIdentity(updates: Partial<U>): Promise<Result<void, Error>>;
  ref<T extends object>(target: T): RefWrapper<T>;
  safeRef<T extends object>(target: T): Result<RefWrapper<T>, Error>;
  release(proxy: object): void;
  safeRelease(proxy: object): Result<void, Error>;

  readonly Expose: <T extends object>(
    token: Token<T, any>,
    options?: ExposeOptions,
  ) => NexusClassDecorator<T>;
  readonly Endpoint: (options: EndpointOptions<U>) => NexusEndpointDecorator<U>;

  // Utilities
  readonly matchers: MatcherUtils<U, RegisteredMatchers>;
}

export interface MatcherUtils<
  U extends EndpointMeta,
  RegisteredMatchers extends string,
> {
  and(
    ...matchers: MatcherTarget<U, RegisteredMatchers>[]
  ): (identity: U) => boolean;
  or(
    ...matchers: MatcherTarget<U, RegisteredMatchers>[]
  ): (identity: U) => boolean;
  not(matcher: MatcherTarget<U, RegisteredMatchers>): (identity: U) => boolean;
}

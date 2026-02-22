import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import type { RefWrapper } from "@/types/ref-wrapper";
import type { Token } from "../token";
import type {
  NexusConfig,
  CreateOptions,
  TargetMatcher,
  CreateMulticastOptions,
} from "./config";
import type { SerializedError } from "@/types/message";
import type { Result, ResultAsync } from "neverthrow";

// 类型工具，用于从配置对象中提取匹配器和描述符的名称
export type GetMatchers<T> = T extends { matchers: infer M }
  ? keyof M & string
  : never;

export type GetDescriptors<T> = T extends { descriptors: infer D }
  ? keyof D & string
  : never;

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
  U extends UserMetadata = any,
  P extends PlatformMetadata = any,
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
    token: Token<T>,
    options: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>,
  ): Promise<Asyncified<T>>;

  safeCreate<T extends object>(
    token: Token<T>,
    options: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>,
  ): ResultAsync<Asyncified<T>, Error>;

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
    token: Token<T>,
    options: O,
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
    token: Token<T>,
    options: O,
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
    token: Token<T>,
    options: O,
  ): ResultAsync<Allified<T>, Error>;

  safeCreateMulticast<
    T extends object,
    const O extends CreateMulticastOptions<
      U,
      "stream",
      RegisteredMatchers,
      RegisteredDescriptors
    >,
  >(
    token: Token<T>,
    options: O,
  ): ResultAsync<Streamified<T>, Error>;

  /**
   * Updates the identity of the current endpoint.
   * @param updates A partial object of the user metadata to update.
   */
  updateIdentity(updates: Partial<U>): Promise<void>;
  safeUpdateIdentity(updates: Partial<U>): ResultAsync<void, Error>;
  ref<T extends object>(target: T): RefWrapper<T>;
  safeRef<T extends object>(target: T): Result<RefWrapper<T>, Error>;
  release(proxy: object): void;
  safeRelease(proxy: object): Result<void, Error>;

  // Utilities
  readonly matchers: MatcherUtils<U, RegisteredMatchers>;
}

export interface MatcherUtils<
  U extends UserMetadata,
  RegisteredMatchers extends string,
> {
  and(
    ...matchers: TargetMatcher<U, RegisteredMatchers>[]
  ): (identity: U) => boolean;
  or(
    ...matchers: TargetMatcher<U, RegisteredMatchers>[]
  ): (identity: U) => boolean;
  not(matcher: TargetMatcher<U, RegisteredMatchers>): (identity: U) => boolean;
}

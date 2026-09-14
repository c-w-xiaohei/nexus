import type { AdapterModel, ContextMetaOf } from "@/types/adapter-model";
import type { RefWrapper } from "../../types/ref-wrapper";
import type { Result } from "better-result";
import type { Token } from "../token";
import type { ConnectionAcquireError, NexusCallError } from "@/errors";
import type { ConnectionWhere } from "@/types/adapter-model";
import type { ConnectOptions, ConnectMulticastOptions } from "./config";
import type {
  EndpointOptions,
  NexusEndpointDecorator,
} from "../decorators/endpoint";
import type { ExposeOptions, NexusClassDecorator } from "../decorators/expose";
import type {
  AuthorizationPolicy,
  NexusConfig,
  ServiceProvider,
} from "./config";
import type { Connection, ConnectionCollection } from "../connection";

export type TokenService<TToken> =
  TToken extends Token<infer T, never> ? T : never;

type RemoteResult<T, M extends AdapterModel> =
  T extends PromiseLike<infer U>
    ? RemoteResult<U, M>
    : T extends RefWrapper<infer U>
      ? Remote<U, M> & Disposable
      : T;
type RemoteArguments<A extends readonly unknown[]> = {
  [K in keyof A]: A[K] | (A[K] extends object ? RefWrapper<A[K]> : never);
};
type RemoteMembers<T, M extends AdapterModel> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: RemoteArguments<A>) => RemoteValue<RemoteResult<R, M>, M>
    : RemoteValue<RemoteResult<T[K], M>, M> &
        (T[K] extends object
          ? Omit<Remote<T[K], M>, keyof RemoteValue<unknown, M>>
          : unknown);
};
/** Maps a shared contract to session-bound lazy calls and read-only remote paths. */
export type Remote<T, M extends AdapterModel = AdapterModel> = (T extends (
  ...args: infer A
) => infer R
  ? (...args: RemoteArguments<A>) => RemoteValue<RemoteResult<R, M>, M>
  : unknown) &
  RemoteMembers<T, M>;
/** First consumption starts this operation; subsequent observations share its terminal result. */
export type RemoteValue<
  T,
  M extends AdapterModel = AdapterModel,
> = PromiseLike<T> & {
  readonly connection: Connection<M>;
  /** Starts or observes this operation and handles its concrete RPC rejection. */
  catch<TResult = never>(
    onRejected?:
      | ((reason: NexusCallError) => TResult | PromiseLike<TResult>)
      | null,
  ): Promise<T | TResult>;
  /** Returns a native Promise after completion, without propagating connection metadata. */
  finally(onFinally?: (() => void) | null): Promise<T>;
};
export type Asyncified<T> = Remote<T>;

export interface NexusInstance<M extends AdapterModel = AdapterModel> {
  /** Acquires one ready session; targetless calls wait passively for a unique match. */
  connect(options?: ConnectOptions<M>): Promise<Connection<M>>;
  /** Captures acquisition failures without cancelling shared runtime work. */
  safeConnect(
    options?: ConnectOptions<M>,
  ): Promise<Result<Connection<M>, ConnectionAcquireError>>;
  /** Strictly acquires explicit targets or snapshots matching ready sessions when targets are absent. */
  connectMulticast(
    options?: ConnectMulticastOptions<M>,
  ): Promise<ConnectionCollection<M>>;
  /** Returns a complete fixed collection or the first definite acquisition failure. */
  safeConnectMulticast(
    options?: ConnectMulticastOptions<M>,
  ): Promise<Result<ConnectionCollection<M>, ConnectionAcquireError>>;
  /** Observes each current or future ready session once without initiating dialing. */
  onConnect(listener: (connection: Connection<M>) => void): () => void;
  /** Observes a session when it first matches the supplied predicate. */
  onConnect(
    where: ConnectionWhere<M>,
    listener: (connection: Connection<M>) => void,
  ): () => void;
  /** Adds bootstrap configuration or returns validation and lifecycle errors. */
  safeConfigure<const T extends NexusConfig<M>>(
    config: T,
  ): Result<NexusInstance<M>, Error>;
  /** Adds configuration and schedules local bootstrap after synchronous registration. */
  configure<const T extends NexusConfig<M>>(config: T): NexusInstance<M>;
  /** Registers a service before bootstrap or publishes it on a ready runtime. */
  provide<T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): this;
  /** Registers a provider descriptor without cloning its service implementation. */
  provide<T extends object>(registration: ServiceProvider<T, M>): this;
  /** Validates and registers a provider batch. */
  provide(registrations: readonly ServiceProvider<object, M>[]): this;
  /** Registers an object service and returns expected registration failures. */
  safeProvide<T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): Result<this, Error>;
  /** Registers a descriptor and preserves structured registration errors. */
  safeProvide<T extends object>(
    registration: ServiceProvider<T, M>,
  ): Result<this, Error>;
  /** Validates and registers a batch without throwing expected registration errors. */
  safeProvide(
    registrations: readonly ServiceProvider<object, M>[],
  ): Result<this, Error>;
  /** Waits for local bootstrap, not remote services or startup connections. */
  ready(): Promise<void>;
  /** Returns the shared bootstrap outcome without an independent initialization attempt. */
  safeReady(): Promise<Result<void, Error>>;
  /** Publishes identity changes after prior provider publications on each live session. */
  updateIdentity(updates: Partial<ContextMetaOf<M>>): Promise<void>;
  /** Captures identity validation and publication errors. */
  safeUpdateIdentity(
    updates: Partial<ContextMetaOf<M>>,
  ): Promise<Result<void, Error>>;
  /** Marks an object for reference transfer when its containing call is encoded. */
  ref<T extends object>(target: T): RefWrapper<T>;
  /** Returns a reference marker or an invalid-object error. */
  safeRef<T extends object>(target: T): Result<RefWrapper<T>, Error>;
  /** Releases a remote reference without invoking application cleanup. */
  release(proxy: object): void;
  /** Captures reference-release errors without closing the shared session. */
  safeRelease(proxy: object): Result<void, Error>;
  /** Binds a class provider to this instance's bootstrap registry. */
  readonly Expose: <T extends object>(
    token: Token<T> | Token<T, M>,
    options?: ExposeOptions,
  ) => NexusClassDecorator<T>;
  /** Binds an endpoint class and its identity to this instance's bootstrap registry. */
  readonly Endpoint: (options: EndpointOptions<M>) => NexusEndpointDecorator<M>;
}

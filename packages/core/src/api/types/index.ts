import type { AdapterModel, ContextMetaOf } from "@/types/adapter-model";
import type { RefWrapper } from "@/types/ref-wrapper";
import type { Result } from "better-result";
import type { Token } from "../token";
import type {
  EndpointOptions,
  NexusEndpointDecorator,
} from "../decorators/endpoint";
import type { ExposeOptions, NexusClassDecorator } from "../decorators/expose";
import type {
  AuthorizationPolicy,
  CreateMulticastOptions,
  CreateOptions,
  SelectMulticastOptions,
  SelectOptions,
  NexusConfig,
  ServiceProvider,
} from "./config";

export type TokenService<TToken> =
  TToken extends Token<infer T, never> ? T : never;
export type RuntimeCreateTokenParam<T extends object, M extends AdapterModel> =
  | Token<T>
  | Token<T, M>;
export type ValidCreateOptions<O> =
  Exclude<keyof O, keyof CreateOptions<AdapterModel>> extends never ? O : never;

type Unwrapped<T> = T extends Promise<infer U> ? U : T;
type AsyncifiedReturn<T> =
  Unwrapped<T> extends RefWrapper<infer U>
    ? Asyncified<U> & Disposable
    : Unwrapped<T>;
export type Asyncified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<AsyncifiedReturn<R>>
    : Promise<Unwrapped<T[K]>>;
};
export type NexusPromiseSettledResult<T> =
  | { status: "fulfilled"; value: T }
  | {
      status: "rejected";
      reason: { message: string; code?: string; name?: string };
    };
export type Allified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<NexusPromiseSettledResult<Unwrapped<R>>[]>
    : Promise<NexusPromiseSettledResult<Unwrapped<T[K]>>[]>;
};
export type Streamified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (
        ...args: A
      ) => Promise<AsyncIterable<NexusPromiseSettledResult<Unwrapped<R>>>>
    : Promise<AsyncIterable<NexusPromiseSettledResult<Unwrapped<T[K]>>>>;
};

export interface NexusInstance<M extends AdapterModel = AdapterModel> {
  safeConfigure<const T extends NexusConfig<M>>(
    config: T,
  ): Result<NexusInstance<M>, Error>;
  configure<const T extends NexusConfig<M>>(config: T): NexusInstance<M>;
  provide<T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): this;
  provide<T extends object>(registration: ServiceProvider<T, M>): this;
  provide(registrations: readonly ServiceProvider<object, M>[]): this;
  safeProvide<T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    options?: { policy?: AuthorizationPolicy<M> },
  ): Result<this, Error>;
  safeProvide<T extends object>(
    registration: ServiceProvider<T, M>,
  ): Result<this, Error>;
  safeProvide(
    registrations: readonly ServiceProvider<object, M>[],
  ): Result<this, Error>;
  ready(): Promise<void>;
  safeReady(): Promise<Result<void, Error>>;
  create<T extends object, const O extends CreateOptions<M> = CreateOptions<M>>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: O & ValidCreateOptions<O>,
  ): Promise<Asyncified<T>>;
  safeCreate<
    T extends object,
    const O extends CreateOptions<M> = CreateOptions<M>,
  >(
    token: RuntimeCreateTokenParam<T, M>,
    options?: O & ValidCreateOptions<O>,
  ): Promise<Result<Asyncified<T>, Error>>;
  createMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M> & { expects: "stream" },
  ): Promise<Streamified<T>>;
  createMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M> & { expects?: "all" },
  ): Promise<Allified<T>>;
  safeCreateMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M> & { expects: "stream" },
  ): Promise<Result<Streamified<T>, Error>>;
  safeCreateMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: CreateMulticastOptions<M> & { expects?: "all" },
  ): Promise<Result<Allified<T>, Error>>;
  select<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: SelectOptions<M>,
  ): Promise<Asyncified<T>>;
  safeSelect<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: SelectOptions<M>,
  ): Promise<Result<Asyncified<T>, Error>>;
  selectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: SelectMulticastOptions<M> & { expects: "stream" },
  ): Promise<Streamified<T>>;
  selectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: SelectMulticastOptions<M> & { expects?: "all" },
  ): Promise<Allified<T>>;
  safeSelectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options: SelectMulticastOptions<M> & { expects: "stream" },
  ): Promise<Result<Streamified<T>, Error>>;
  safeSelectMulticast<T extends object>(
    token: RuntimeCreateTokenParam<T, M>,
    options?: SelectMulticastOptions<M> & { expects?: "all" },
  ): Promise<Result<Allified<T>, Error>>;
  updateIdentity(updates: Partial<ContextMetaOf<M>>): Promise<void>;
  safeUpdateIdentity(
    updates: Partial<ContextMetaOf<M>>,
  ): Promise<Result<void, Error>>;
  ref<T extends object>(target: T): RefWrapper<T>;
  safeRef<T extends object>(target: T): Result<RefWrapper<T>, Error>;
  release(proxy: object): void;
  safeRelease(proxy: object): Result<void, Error>;
  readonly Expose: <T extends object>(
    token: Token<T> | Token<T, M>,
    options?: ExposeOptions,
  ) => NexusClassDecorator<T>;
  readonly Endpoint: (options: EndpointOptions<M>) => NexusEndpointDecorator<M>;
}

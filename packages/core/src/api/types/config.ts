import type { EndpointMeta, PlatformMeta } from "@/types/identity";
import type { IEndpoint } from "@/transport";
import type { Token } from "../token";

type AtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

export type DescriptorTarget<
  U,
  RegisteredDescriptors extends string = string,
> = Partial<U> | RegisteredDescriptors;

export type MatcherTarget<U, M extends string> = M | ((identity: U) => boolean);

export interface Target<
  U extends EndpointMeta,
  M extends string,
  D extends string,
> {
  descriptor?: DescriptorTarget<U, D>;
  matcher?: MatcherTarget<U, M>;
}

/**
 * Token default target criteria. This intentionally allows descriptor,
 * matcher, or both together, but only as inline values: named descriptor and
 * matcher strings are resolved at call-sites/config layers, not from tokens.
 */
export type InlineTarget<U extends EndpointMeta> = AtLeastOne<{
  descriptor: Partial<U>;
  matcher: (identity: U) => boolean;
}>;

export interface MulticastTarget<
  U extends EndpointMeta,
  M extends string,
  D extends string,
> extends Target<U, M, D> {
  group?: string;
}

export interface MessageTarget<
  U extends EndpointMeta,
  RegisteredMatchers extends string = string,
  RegisteredDescriptors extends string = string,
> {
  connectionId?: string;
  group?: string;
  matcher?: MatcherTarget<U, RegisteredMatchers>;
  descriptor?: DescriptorTarget<U, RegisteredDescriptors>;
}

export interface CreateOptions<
  U extends EndpointMeta,
  M extends string,
  D extends string,
> {
  target?: Target<U, M, D> | null;
  expects?: "one" | "first";
  timeout?: number;
}

export interface CreateMulticastOptions<
  U extends EndpointMeta,
  E extends "all" | "stream",
  M extends string,
  D extends string,
> {
  target: MulticastTarget<U, M, D>;
  expects?: E;
  timeout?: number;
}

export interface EndpointConfig<
  U extends EndpointMeta,
  P extends PlatformMeta,
  _RegisteredMatchers extends string = string,
  _RegisteredDescriptors extends string = string,
> {
  meta?: U;
  implementation?: IEndpoint<U, P>;
  connectTo?: readonly Target<U, _RegisteredMatchers, _RegisteredDescriptors>[];
}

export interface ConnectionAuthContext<
  U extends EndpointMeta,
  P extends PlatformMeta,
> {
  readonly localIdentity: U;
  readonly remoteIdentity: U;
  readonly platform: P;
  readonly direction: "incoming" | "outgoing";
}

export interface ServiceCallAuthContext<
  U extends EndpointMeta,
  P extends PlatformMeta,
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
  U extends EndpointMeta,
  P extends PlatformMeta = PlatformMeta,
> {
  canConnect?(context: ConnectionAuthContext<U, P>): boolean | Promise<boolean>;
  canCall?(context: ServiceCallAuthContext<U, P>): boolean | Promise<boolean>;
}

export type AuthorizationPolicy<
  U extends EndpointMeta,
  P extends PlatformMeta = PlatformMeta,
> = NexusAuthorizationPolicy<U, P>;

export interface ServiceProvider<
  T,
  U extends EndpointMeta = EndpointMeta,
  P extends PlatformMeta = PlatformMeta,
> {
  token: Token<T, any>;
  service: T;
  policy?: AuthorizationPolicy<U, P>;
}

export interface NexusConfig<
  U extends EndpointMeta,
  P extends PlatformMeta,
  _RegisteredMatchers extends string = string,
  _RegisteredDescriptors extends string = string,
> {
  endpoint?: EndpointConfig<U, P, _RegisteredMatchers, _RegisteredDescriptors>;
  providers?: ServiceProvider<object, U, P>[];
  matchers?: Record<string, (identity: U) => boolean>;
  descriptors?: Record<string, Partial<U>>;
  policy?: NexusAuthorizationPolicy<U, P>;
}

export function serviceProvider<
  T extends object,
  U extends EndpointMeta = EndpointMeta,
  P extends PlatformMeta = PlatformMeta,
>(
  token: Token<T, U>,
  service: T,
  options?: { policy?: AuthorizationPolicy<U, P> },
): ServiceProvider<T, U, P> {
  return { token, service, policy: options?.policy };
}

export function defineNexusConfig<const T extends NexusConfig<any, any>>(
  config: T,
): T {
  return config;
}

export function composeNexusConfig<
  U extends EndpointMeta,
  P extends PlatformMeta,
>(layers: readonly NexusConfig<U, P, string, string>[]): NexusConfig<U, P> {
  const composed: NexusConfig<U, P> = {};
  const providersById = new Map<string, ServiceProvider<object, U, P>>();

  for (const layer of layers) {
    if (layer.endpoint) {
      composed.endpoint = {
        ...(composed.endpoint ?? {}),
        ...(Object.hasOwn(layer.endpoint, "meta")
          ? { meta: layer.endpoint.meta }
          : {}),
        ...(Object.hasOwn(layer.endpoint, "implementation")
          ? { implementation: layer.endpoint.implementation }
          : {}),
        ...(Object.hasOwn(layer.endpoint, "connectTo")
          ? { connectTo: layer.endpoint.connectTo }
          : {}),
      };
    }
    if (Object.hasOwn(layer, "policy")) {
      composed.policy = layer.policy;
    }
    if (layer.descriptors) {
      composed.descriptors = {
        ...(composed.descriptors ?? {}),
        ...layer.descriptors,
      };
    }
    if (layer.matchers) {
      composed.matchers = { ...(composed.matchers ?? {}), ...layer.matchers };
    }
    for (const provider of layer.providers ?? []) {
      providersById.set(provider.token.id, provider);
    }
  }

  if (providersById.size > 0) {
    composed.providers = Array.from(providersById.values());
  }
  return composed;
}

import type {
  AdapterModel,
  ConnectionTargetOf,
  ConnectionWhere,
  ConnectionMetaOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import type { IEndpoint } from "@/transport";
import type { Token } from "../token";

export interface CreateOptions<M extends AdapterModel> {
  target?: ConnectionTargetOf<M>;
  where?: ConnectionWhere<M>;
  timeout?: number;
  signal?: AbortSignal;
  callTimeout?: number;
}

export interface CreateMulticastOptions<M extends AdapterModel> {
  targets: readonly ConnectionTargetOf<M>[];
  where?: ConnectionWhere<M>;
  expects?: "all" | "stream";
  timeout?: number;
  signal?: AbortSignal;
  callTimeout?: number;
}

export interface SelectOptions<M extends AdapterModel> {
  where?: ConnectionWhere<M>;
  wait?: { timeout?: number; signal?: AbortSignal };
  callTimeout?: number;
}

export interface SelectMulticastOptions<M extends AdapterModel> {
  where?: ConnectionWhere<M>;
  expects?: "all" | "stream";
  callTimeout?: number;
}

export interface EndpointConfig<M extends AdapterModel> {
  meta?: ContextMetaOf<M>;
  implementation?: IEndpoint<M>;
  defaultTarget?: ConnectionTargetOf<M>;
}

export interface ConnectionAuthContext<M extends AdapterModel> {
  readonly localIdentity: ContextMetaOf<M>;
  readonly remoteIdentity: ContextMetaOf<M>;
  readonly connection: ConnectionMetaOf<M>;
  readonly direction: "incoming" | "outgoing";
}

export interface ServiceCallAuthContext<M extends AdapterModel> {
  readonly localIdentity: ContextMetaOf<M>;
  readonly remoteIdentity: ContextMetaOf<M>;
  readonly connection: ConnectionMetaOf<M>;
  readonly connectionId: string;
  readonly serviceName: string;
  readonly path: (string | number)[];
  readonly operation: "GET" | "SET" | "APPLY";
}

export interface NexusAuthorizationPolicy<M extends AdapterModel> {
  canConnect?(context: ConnectionAuthContext<M>): boolean | Promise<boolean>;
  canCall?(context: ServiceCallAuthContext<M>): boolean | Promise<boolean>;
}

export type AuthorizationPolicy<M extends AdapterModel> =
  NexusAuthorizationPolicy<M>;

export interface ServiceProvider<T, M extends AdapterModel> {
  token: Token<T> | Token<T, M>;
  service: T;
  policy?: AuthorizationPolicy<M>;
}

export interface NexusConfig<M extends AdapterModel> {
  endpoint?: EndpointConfig<M>;
  providers?: ServiceProvider<object, M>[];
  policy?: NexusAuthorizationPolicy<M>;
}

export function serviceProvider<T, M extends AdapterModel>(
  token: Token<T, any>,
  service: T,
  options?: { policy?: AuthorizationPolicy<M> },
): ServiceProvider<T, M> {
  return { token, service, policy: options?.policy };
}

export function defineNexusConfig<const T extends NexusConfig<AdapterModel>>(
  config: T,
): T {
  return config;
}

export function composeNexusConfig<M extends AdapterModel>(
  layers: readonly NexusConfig<M>[],
): NexusConfig<M> {
  const composed: NexusConfig<M> = {};
  const providersById = new Map<string, ServiceProvider<object, M>>();

  for (const layer of layers) {
    if (layer.endpoint) {
      composed.endpoint = { ...(composed.endpoint ?? {}), ...layer.endpoint };
    }
    if (Object.hasOwn(layer, "policy")) {
      composed.policy = layer.policy;
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

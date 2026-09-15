import type {
  AdapterModel,
  ConnectionTargetOf,
  ConnectionWhere,
  ConnectionMetaOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import type { IEndpoint } from "@/transport";
import { isPlainTarget, Token } from "../token";
import { NexusConfigurationError } from "@/errors";
import { Result } from "better-result";

/** Rejects duplicate declarations within one submission, before cross-layer last-wins composition. */
export function validateProviderBatch<M extends AdapterModel>(
  providers: readonly ServiceProvider<object, M>[],
): Result<void, NexusConfigurationError> {
  if (
    !Array.isArray(providers) ||
    !Array.from(providers).every(
      (provider) =>
        provider !== null &&
        typeof provider === "object" &&
        provider.token instanceof Token &&
        provider.service !== null &&
        (typeof provider.service === "object" ||
          typeof provider.service === "function"),
    )
  ) {
    return Result.err(
      new NexusConfigurationError(
        "Provider declarations require a Token and a service object.",
        "E_PROVIDER_BATCH_INVALID",
      ),
    );
  }
  return validateProviderIds(providers.map(({ token }) => token.id));
}

/** Checks declaration identities before composition or any user factory executes. */
export function validateProviderIds(
  ids: readonly string[],
): Result<void, NexusConfigurationError> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates.size
    ? Result.err(
        new NexusConfigurationError(
          "Provider batch contains duplicate token IDs.",
          "E_PROVIDER_DUPLICATE_TOKEN",
          { duplicateTokenIds: [...duplicates] },
        ),
      )
    : Result.ok(undefined);
}

/** Validates a positive, finite millisecond budget without coercing business input. */
export function isValidTimeout(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value > 0)
  );
}

/** Accepts only plain options records and explicitly supported enumerable keys. */
export function hasOnlyOptionKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isPlainTarget(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

/** Request-scoped connection acquisition. Predicates select a session, not an RPC authorization policy. */
export interface ConnectOptions<M extends AdapterModel> {
  /** Exact address to reuse or dial. Omit to wait for an existing matching session. */
  target?: ConnectionTargetOf<M>;
  /** Acquisition-only AND predicate over peer identity and local adapter facts. */
  where?: ConnectionWhere<M>;
  /** Positive finite milliseconds, covering bootstrap and acquisition; passive default is unbounded. */
  timeout?: number;
  /** Aborts this wait without closing shared sessions or controlling future calls. */
  signal?: AbortSignal;
}

/** Fixed-session acquisition, with strict all-target success when targets are supplied. */
export interface ConnectMulticastOptions<M extends AdapterModel> {
  /** Explicit targets in output order. Omit to snapshot current peers; an empty list acquires none. */
  targets?: readonly ConnectionTargetOf<M>[];
  /** Filters acquired sessions only; use authorization policy for ongoing call access. */
  where?: ConnectionWhere<M>;
  /** Shared positive finite budget for the entire acquisition, defaulting to 30 seconds. */
  timeout?: number;
  /** Stops this caller's wait while keeping observed shared dialing attempts alive. */
  signal?: AbortSignal;
}

export interface EndpointConfig<M extends AdapterModel> {
  meta?: ContextMetaOf<M>;
  implementation?: IEndpoint<M>;
  /**
   * Exact peers to connect to once after local listening starts. Independent of
   * service acquisition: no Token is required and ready() does not await these dials.
   * Failures are logged; startup targets are not retried or reconnected.
   */
  connectTo?: readonly ConnectionTargetOf<M>[];
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
  /** Authorizes connection admission and later peer identity changes. */
  canConnect?(context: ConnectionAuthContext<M>): boolean | Promise<boolean>;
  /** Authorizes each incoming operation independently of acquisition predicates. */
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
  callTimeout?: number;
  endpoint?: EndpointConfig<M>;
  providers?: ServiceProvider<object, M>[];
  policy?: NexusAuthorizationPolicy<M>;
}

/** Describes a provider without registering it or constructing another service instance. */
export function serviceProvider<T, M extends AdapterModel>(
  token: Token<T, any>,
  service: T,
  options?: { policy?: AuthorizationPolicy<M> },
): ServiceProvider<T, M> {
  return { token, service, policy: options?.policy };
}

/** Preserves inferred configuration literals while checking the public configuration shape. */
export function defineNexusConfig<const T extends NexusConfig<AdapterModel>>(
  config: T,
): T {
  return config;
}

/** Combines layers with last-wins endpoint fields, policies, and provider identities. */
export function composeNexusConfig<M extends AdapterModel>(
  layers: readonly NexusConfig<M>[],
): NexusConfig<M> {
  const composed: NexusConfig<M> = {};
  const providersById = new Map<string, ServiceProvider<object, M>>();

  for (const layer of layers) {
    if (layer.callTimeout !== undefined)
      composed.callTimeout = layer.callTimeout;
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

/** Capture endpoint data before async bootstrap; keep the endpoint implementation by identity. */
export function snapshotEndpoint<T extends EndpointConfig<any>>(
  endpoint: T,
): T {
  return {
    ...endpoint,
    meta: copyConfigData(endpoint.meta),
    connectTo: copyConfigData(endpoint.connectTo),
  };
}

/** Services, policies and implementations are capabilities, not cloneable configuration data. */
export function snapshotConfig<M extends AdapterModel>(
  config: NexusConfig<M>,
): NexusConfig<M> {
  return {
    ...config,
    endpoint: config.endpoint ? snapshotEndpoint(config.endpoint) : undefined,
    providers: config.providers?.map((provider) => ({ ...provider })),
  };
}

/** Copies serializable configuration values while leaving capability identity handling to callers. */
function copyConfigData<T>(value: T): T {
  // Date has JSON value semantics but no enumerable fields. Keep that value
  // instead of turning accepted metadata into an empty record.
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (Array.isArray(value)) {
    return value.map(copyConfigData) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copyConfigData(item)]),
    ) as T;
  }
  return value;
}

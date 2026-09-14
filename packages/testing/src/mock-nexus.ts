import {
  Nexus,
  NexusDisconnectedError,
  NexusServiceError,
  NexusUsageError,
  Token,
  type AdapterModel,
  type Connection,
  type ConnectionMetaOf,
  ConnectionCollection,
  type ConnectMulticastOptions,
  type ConnectOptions,
  type ConnectionTargetOf,
  type ContextMetaOf,
  type NexusConfig,
  type NexusInstance,
  type Remote,
  type ResourceAcquireError,
  type ResourceOptions,
} from "@nexus-js/core";
import { createInMemoryServiceProxy } from "@nexus-js/core/internal/testing";
import { Result } from "better-result";

const { err, ok } = Result;
export interface MockProviderRegistration<M extends AdapterModel> {
  readonly target?: ConnectionTargetOf<M>;
  readonly contextMeta: ContextMetaOf<M>;
  readonly connectionMeta: ConnectionMetaOf<M>;
}

interface RegisteredService<M extends AdapterModel> {
  readonly service: object;
  readonly registration?: MockProviderRegistration<M>;
  readonly connection: Connection<M>;
}

export interface MockNexus<M extends AdapterModel = AdapterModel> {
  readonly nexus: NexusInstance<M>;
  service<T extends object>(
    token: Token<T> | Token<T, M>,
    implementation: T,
    registration?: MockProviderRegistration<M>,
  ): void;
  clear<T extends object>(token?: Token<T> | Token<T, M>): void;
  readonly calls: {
    connect(): readonly { readonly options: ConnectOptions<M> }[];
    connectMulticast(): readonly {
      readonly options: ConnectMulticastOptions<M>;
    }[];
    configure(): readonly { readonly config: NexusConfig<M> }[];
    release(): readonly { readonly proxy: object }[];
    updateIdentity(): readonly {
      readonly updates: Partial<ContextMetaOf<M>>;
    }[];
  };
}

/** Identifies option and metadata records accepted by the mock boundary. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Identifies Core Token instances without accepting arbitrary token-shaped objects. */
const isToken = <T extends object>(token: unknown): token is Token<T, any> =>
  token instanceof Token;

/** Rejects unknown option keys so the mock follows the public API contract. */
const hasOnlyKeys = (value: object, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

/** Validates positive acquisition and call budgets. */
const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
/** Identifies native abort signals at the runtime boundary. */
const isAbortSignal = (value: unknown): value is AbortSignal =>
  value instanceof globalThis.AbortSignal;

/** Creates a structured invalid-usage error with optional request diagnostics. */
const usageError = (message: string, context?: Record<string, unknown>) =>
  new NexusUsageError(message, "E_USAGE_INVALID", { context });

/** Creates a structured connection acquisition error with diagnostics. */
const serviceError = (
  message: string,
  code:
    | "E_SERVICE_ACQUISITION_TIMEOUT"
    | "E_SERVICE_NO_MATCH"
    | "E_SERVICE_AMBIGUOUS"
    | "E_ABORTED",
  context?: Record<string, unknown>,
) => new NexusServiceError(message, code, { context });

/** Creates a connection-only Nexus mock for application-level unit tests. */
export function createMockNexus<
  M extends AdapterModel = AdapterModel,
>(): MockNexus<M> {
  const refFactory = new Nexus<M>();
  const providers = new Map<string, RegisteredService<M>[]>();
  const connectionListeners = new Set<() => void>();
  const connectCalls: { options: ConnectOptions<M> }[] = [];
  const connectMulticastCalls: { options: ConnectMulticastOptions<M> }[] = [];
  const configureCalls: { config: NexusConfig<M> }[] = [];
  const releaseCalls: { proxy: object }[] = [];
  const updateIdentityCalls: { updates: Partial<ContextMetaOf<M>> }[] = [];
  let callTimeout = 5_000;
  let connectionSequence = 0;
  const connectionHandles = new Map<string, Connection<M>>();

  /** Creates one session-bound mock connection for a provider registration. */
  const createConnection = (
    registration: MockProviderRegistration<M> | undefined,
  ): Connection<M> => {
    const id = `mock-${++connectionSequence}`;
    let connected = true;
    const contextMeta = Object.freeze({
      ...registration?.contextMeta,
    }) as Readonly<ContextMetaOf<M>>;
    const connectionMeta = Object.freeze({
      ...registration?.connectionMeta,
    }) as Readonly<ConnectionMetaOf<M>>;
    const disconnected = new Set<(reason: "local") => void>();
    const connection: Connection<M> = {
      id,
      get status() {
        return connected ? "connected" : "disconnected";
      },
      get disconnectReason() {
        return connected ? undefined : "local";
      },
      get contextMeta(): Readonly<ContextMetaOf<M>> {
        return contextMeta;
      },
      get connectionMeta(): Readonly<ConnectionMetaOf<M>> {
        return connectionMeta;
      },
      /** Returns a throw-style resource proxy for this session. */
      get: <T extends object>(
        token: Token<T> | Token<T, M>,
        options?: ResourceOptions,
      ): Remote<T, M> => {
        const result = connection.safeGet(token, options);
        if (result.isErr()) throw result.error;
        return result.value;
      },
      /** Returns a resource Result without waiting for provider publication. */
      safeGet: <T extends object>(
        token: Token<T> | Token<T, M>,
        options: ResourceOptions = {},
      ): Result<Remote<T, M>, ResourceAcquireError> => {
        if (
          !isToken<T>(token) ||
          !isPlainObject(options) ||
          !hasOnlyKeys(options, ["callTimeout"]) ||
          (options.callTimeout !== undefined &&
            !isPositiveFinite(options.callTimeout))
        )
          return err(
            new NexusUsageError(
              "get requires a Token and a positive finite callTimeout.",
              "E_USAGE_INVALID",
              { context: { connectionId: connection.id } },
            ),
          );
        const provider: RegisteredService<M> | undefined = registrationsFor(
          token.id,
        ).find((item) => item.connection === connection);
        if (!connected)
          return err(
            new NexusDisconnectedError(
              "The session is disconnected.",
              "E_CONN_CLOSED",
              { connectionId: connection.id },
            ),
          );
        if (!provider) {
          return err(
            new NexusServiceError(
              `Service '${token.id}' is unavailable.`,
              "E_SERVICE_UNAVAILABLE",
              {
                context: {
                  connectionId: connection.id,
                  serviceName: token.id,
                },
              },
            ),
          );
        }
        return ok(
          createInMemoryServiceProxy(
            provider.service as T,
            connection,
            options.callTimeout ?? callTimeout,
            token.id,
          ),
        );
      },
      /** Closes this shared mock session and notifies its observers. */
      disconnect: () => {
        if (!connected) {
          return;
        }
        connected = false;
        for (const [key, handle] of connectionHandles) {
          if (handle === connection) {
            connectionHandles.delete(key);
          }
        }
        for (const listener of [...disconnected]) {
          if (!disconnected.has(listener)) continue;
          disconnected.delete(listener);
          try {
            listener("local");
          } catch {
            // One observer must not prevent other lifecycle observers.
          }
        }
        disconnected.clear();
      },
      /** Registers a terminal session observer, including late observers. */
      onDisconnected: (listener) => {
        if (!connected) {
          try {
            listener("local");
          } catch {
            // Late observer failures are isolated as well.
          }
          return () => {};
        }
        const notify = (reason: "local") => listener(reason);
        disconnected.add(notify);
        return () => disconnected.delete(notify);
      },
      /** Delivers the current peer metadata to an identity observer. */
      subscribeIdentity: (
        listener: (meta: Readonly<ContextMetaOf<M>>) => void,
      ) => {
        if (connected) {
          try {
            listener(contextMeta);
          } catch {
            /* Isolate observer failures. */
          }
        }
        return () => {};
      },
    };
    return connection;
  };

  /** Reuses the mock session associated with one provider registration. */
  const connectionFor = (
    registration: MockProviderRegistration<M> | undefined,
  ): Connection<M> => {
    const key = JSON.stringify(registration ?? null);
    let connection = connectionHandles.get(key);
    if (!connection) {
      connection = createConnection(registration);
      connectionHandles.set(key, connection);
    }
    return connection;
  };

  /** Returns registered services for a token without selecting a provider. */
  const registrationsFor = (tokenId: string) => providers.get(tokenId) ?? [];

  /** Matches registered address fields; an unscoped mock remains usable with any target. */
  const matchesTarget = (
    connection: Connection<M>,
    target: ConnectionTargetOf<M>,
  ): boolean => {
    for (const entries of providers.values()) {
      const provider = entries.find((entry) => entry.connection === connection);
      if (!provider) continue;
      const address = provider.registration?.target;
      return (
        !address ||
        Object.entries(target).every(
          ([key, value]) => (address as Record<string, unknown>)[key] === value,
        )
      );
    }
    return true;
  };

  /** Registers a service and publishes its connection to mock observers. */
  const registerService = <T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    registration?: MockProviderRegistration<M>,
  ) => {
    const registered: RegisteredService<M> = {
      service,
      registration,
      connection: connectionFor(registration),
    };
    const entries = registrationsFor(token.id);
    providers.set(token.id, [...entries, registered]);
    for (const listener of connectionListeners) listener();
  };

  /** Validates connection acquisition options at the mock API boundary. */
  const validateConnectOptions = (
    value: unknown,
    multicast: boolean,
  ): Result<void, Error> => {
    const address = multicast ? "targets" : "target";
    if (
      !isPlainObject(value) ||
      !hasOnlyKeys(value, [address, "where", "timeout", "signal"])
    )
      return err(
        usageError("Mock Nexus connect options are invalid.", {
          target: isPlainObject(value) ? value.target : undefined,
          targets: isPlainObject(value) ? value.targets : undefined,
        }),
      );
    if (
      (value.where !== undefined && typeof value.where !== "function") ||
      (value.timeout !== undefined && !isPositiveFinite(value.timeout)) ||
      (value.signal !== undefined && !isAbortSignal(value.signal))
    )
      return err(
        usageError("Mock Nexus connect options are invalid.", {
          target: value.target,
          targets: value.targets,
        }),
      );
    if (
      (multicast &&
        value.targets !== undefined &&
        (!Array.isArray(value.targets) ||
          value.targets.length !== Object.keys(value.targets).length ||
          value.targets.some((target) => !isPlainObject(target)))) ||
      (!multicast && value.target !== undefined && !isPlainObject(value.target))
    )
      return err(
        usageError("Mock Nexus connect targets must be objects.", {
          target: value.target,
          targets: value.targets,
        }),
      );
    return ok(undefined);
  };

  /** Returns matching sessions or the predicate failure, preserving the offending session's identity. */
  const connections = (
    where?: ConnectOptions<M>["where"],
  ): Result<Connection<M>[], NexusUsageError> => {
    const matching: Connection<M>[] = [];
    for (const connection of connectionHandles.values()) {
      if (connection.status !== "connected") continue;
      if (!where) {
        matching.push(connection);
        continue;
      }
      try {
        if (where(connection.contextMeta, connection.connectionMeta))
          matching.push(connection);
      } catch (cause) {
        return err(
          new NexusUsageError(
            "Mock Nexus connection where predicate threw.",
            "E_USAGE_INVALID",
            {
              context: { connectionId: connection.id },
              cause:
                cause instanceof Error
                  ? { name: cause.name, message: cause.message }
                  : { name: "Error", message: String(cause) },
            },
          ),
        );
      }
    }
    return ok(matching);
  };

  /** Unwraps a mock Result at a throw-style public boundary. */
  const unwrap = <T>(result: Result<T, Error>): T => {
    if (result.isErr()) throw result.error;
    return result.value;
  };
  /** Acquires one existing session, waiting for a unique passive match when needed. */
  const safeConnect = async (
    options: ConnectOptions<M> = {},
  ): Promise<Result<Connection<M>, Error>> => {
    const valid = validateConnectOptions(options, false);
    if (valid.isErr()) return valid;
    if (options.signal?.aborted)
      return err(
        serviceError("Connection acquisition was aborted.", "E_ABORTED"),
      );
    connectCalls.push({ options });
    /** Captures predicate failures while selecting from the current ready-session snapshot. */
    const scan = () =>
      connections(options.where).map((matching) =>
        matching.filter(
          (connection) =>
            !options.target || matchesTarget(connection, options.target),
        ),
      );
    /** Resolves a unique match, reports ambiguity, or leaves an empty passive scan pending. */
    const settle = (found: readonly Connection<M>[]) =>
      found.length === 1
        ? ok(found[0])
        : found.length > 1
          ? err(
              serviceError(
                "Mock Nexus connect requires one matching connection.",
                "E_SERVICE_AMBIGUOUS",
                {
                  target: options.target,
                  matchingConnectionCount: found.length,
                },
              ),
            )
          : undefined;
    const initial = scan();
    if (initial.isErr()) return initial;
    const settled = settle(initial.value);
    if (settled) return settled;
    if (options.target)
      return err(
        serviceError(
          "Mock Nexus target has no matching connection.",
          "E_SERVICE_NO_MATCH",
          {
            target: options.target,
          },
        ),
      );
    return new Promise<Result<Connection<M>, Error>>((resolve) => {
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let scheduled = false;
      /** Releases request-local observation before delivering the acquisition outcome. */
      const finish = (result: Result<Connection<M>, Error>) => {
        connectionListeners.delete(onRegister);
        if (timer) globalThis.clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      /** Coalesces synchronous registrations before evaluating unique-session cardinality. */
      const onRegister = () => {
        if (scheduled) return;
        scheduled = true;
        globalThis.queueMicrotask(() => {
          scheduled = false;
          const result = scan();
          if (result.isErr()) return finish(result);
          const next = settle(result.value);
          if (next) finish(next);
        });
      };
      /** Ends only this pending acquisition when its caller aborts. */
      const onAbort = () =>
        finish(
          err(
            serviceError("Connection acquisition was aborted.", "E_ABORTED", {
              target: options.target,
            }),
          ),
        );
      connectionListeners.add(onRegister);
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeout !== undefined)
        timer = globalThis.setTimeout(
          () =>
            finish(
              err(
                serviceError(
                  "Mock Nexus connection acquisition timed out.",
                  "E_SERVICE_ACQUISITION_TIMEOUT",
                  { target: options.target, timeout: options.timeout },
                ),
              ),
            ),
          options.timeout,
        );
    });
  };

  /** Captures a fixed snapshot of existing mock connections. */
  const safeConnectMulticast = async (
    options: ConnectMulticastOptions<M> = {},
  ): Promise<Result<ConnectionCollection<M>, Error>> => {
    const valid = validateConnectOptions(options, true);
    if (valid.isErr()) return valid;
    if (options.signal?.aborted)
      return err(
        serviceError("Connection acquisition was aborted.", "E_ABORTED"),
      );
    connectMulticastCalls.push({ options });
    const matching = connections(options.where);
    if (matching.isErr()) return matching;
    if (options.targets === undefined)
      return ok(new ConnectionCollection(matching.value));
    const selected = new Set<Connection<M>>();
    for (const target of options.targets) {
      const connection = matching.value.find((candidate) =>
        matchesTarget(candidate, target),
      );
      if (!connection) {
        return err(
          serviceError(
            "A target has no mock connection.",
            "E_SERVICE_NO_MATCH",
            {
              targets: options.targets,
            },
          ),
        );
      }
      selected.add(connection);
    }
    return ok(new ConnectionCollection([...selected]));
  };

  const nexus = {
    /** Acquires one existing mock session or throws its Result error. */
    connect: (options: ConnectOptions<M> = {}) =>
      safeConnect(options).then(unwrap),
    /** Acquires one existing mock session as a Promise<Result>. */
    safeConnect,
    /** Captures existing sessions and throws if a requested target is absent. */
    connectMulticast: (options: ConnectMulticastOptions<M> = {}) =>
      safeConnectMulticast(options ?? {}).then(unwrap),
    /** Captures existing sessions as a Promise<Result>. */
    safeConnectMulticast,
    /** Observes each matching existing or newly registered session once. */
    onConnect: ((whereOrListener: unknown, listener?: unknown) => {
      const where =
        typeof listener === "function"
          ? (whereOrListener as ConnectOptions<M>["where"])
          : undefined;
      const receive = (listener ?? whereOrListener) as (
        connection: Connection<M>,
      ) => void;
      const seen = new WeakSet<Connection<M>>();
      let active = true;
      /** Delivers each unseen ready session once to this observer. */
      const notify = () => {
        for (const connection of unwrap(connections(where))) {
          if (active && !seen.has(connection)) {
            seen.add(connection);
            try {
              receive(connection);
            } catch {
              /* Isolate each subscription. */
            }
          }
        }
      };
      connectionListeners.add(notify);
      notify();
      return () => {
        active = false;
        connectionListeners.delete(notify);
      };
    }) as NexusInstance<M>["onConnect"],
    /** Applies mock configuration using the throw-style boundary. */
    configure: (config: NexusConfig<M>) => unwrap(nexus.safeConfigure(config)),
    /** Applies mock configuration without throwing expected validation errors. */
    safeConfigure: (config: NexusConfig<M>) => {
      if (!isPlainObject(config as unknown))
        return err(usageError("Mock Nexus configure options are invalid."));
      if (
        config.callTimeout !== undefined &&
        !isPositiveFinite(config.callTimeout)
      )
        return err(usageError("callTimeout must be positive and finite."));
      if (config.callTimeout !== undefined) callTimeout = config.callTimeout;
      configureCalls.push({ config });
      for (const provider of config.providers ?? [])
        registerService(provider.token, provider.service);
      return ok(nexus);
    },
    /** Registers one or more live providers using the throw-style boundary. */
    provide: ((input: unknown, service?: object) =>
      unwrap(
        nexus.safeProvide(input as never, service as never),
      )) as NexusInstance<M>["provide"],
    /** Registers live providers without throwing expected validation errors. */
    safeProvide: ((input: unknown, service?: object) => {
      const registrations =
        isToken(input) && service
          ? [{ token: input, service }]
          : Array.isArray(input)
            ? input
            : isPlainObject(input) && isToken(input.token) && input.service
              ? [input]
              : undefined;
      if (!registrations)
        return err(usageError("Mock Nexus provide input is invalid."));
      for (const registration of registrations)
        registerService(registration.token, registration.service);
      return ok(nexus);
    }) as NexusInstance<M>["safeProvide"],
    /** Resolves immediately because the mock has no bootstrap transport. */
    ready: async () => undefined,
    /** Returns immediate mock readiness as a Result. */
    safeReady: async () => ok(undefined),
    /** Updates local metadata through the throw-style boundary. */
    updateIdentity: async (updates: Partial<ContextMetaOf<M>>) => {
      const result = await nexus.safeUpdateIdentity(updates);
      if (result.isErr()) throw result.error;
    },
    /** Updates local metadata without throwing expected validation errors. */
    safeUpdateIdentity: (updates: Partial<ContextMetaOf<M>>) => {
      if (!isPlainObject(updates))
        return Promise.resolve(
          err(usageError("Mock Nexus identity updates are invalid.")),
        );
      updateIdentityCalls.push({ updates });
      return Promise.resolve(ok(undefined));
    },
    /** Wraps an object as a session-independent local reference. */
    ref: (target: object) => refFactory.ref(target),
    /** Safely wraps an object as a local reference. */
    safeRef: (target: object) => refFactory.safeRef(target),
    /** Releases a resource proxy through Core's release boundary. */
    release: (proxy: object) => {
      releaseCalls.push({ proxy });
      Nexus.release(proxy);
    },
    /** Releases a resource proxy without throwing expected errors. */
    safeRelease: (proxy: object) => {
      releaseCalls.push({ proxy });
      return Nexus.safeRelease(proxy);
    },
    /** Provides the mock-bound class decorator shape. */
    Expose: () => () => undefined,
    /** Provides the mock-bound endpoint decorator shape. */
    Endpoint: () => () => undefined,
  } as unknown as NexusInstance<M>;

  return {
    nexus,
    /** Registers a service and its optional connection metadata. */
    service: registerService,
    /** Clears one token's providers or all mock lifecycle state. */
    clear: (token) => {
      if (token) {
        providers.delete(token.id);
        return;
      }
      providers.clear();
      connectCalls.length = 0;
      connectMulticastCalls.length = 0;
      configureCalls.length = 0;
      releaseCalls.length = 0;
      updateIdentityCalls.length = 0;
      connectionHandles.clear();
    },
    calls: {
      /** Returns an independent snapshot of connect calls. */
      connect: () => [...connectCalls],
      /** Returns an independent snapshot of multicast connect calls. */
      connectMulticast: () => [...connectMulticastCalls],
      /** Returns an independent snapshot of configure calls. */
      configure: () => [...configureCalls],
      /** Returns an independent snapshot of release calls. */
      release: () => [...releaseCalls],
      /** Returns an independent snapshot of local identity updates. */
      updateIdentity: () => [...updateIdentityCalls],
    },
  };
}

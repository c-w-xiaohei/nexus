import {
  Nexus,
  NexusDisconnectedError,
  NexusResourceError,
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
  type ResourceScope,
} from "@nexus-js/core";
import {
  createInMemoryServiceProxy,
  safeAcquireConnection,
  safeAcquireConnections,
  type AcquisitionSession,
  type AcquisitionSource,
} from "@nexus-js/core/internal/testing";
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

/** Validates positive acquisition and call budgets. */
const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Creates a mock-only validation error outside the shared acquisition contract. */
const usageError = (message: string, context?: Record<string, unknown>) =>
  new NexusUsageError(message, "E_USAGE_INVALID", { context });
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
    const scopes = new WeakSet<ResourceScope>();
    let scopeSequence = 0;
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
      createScope: <T extends object>(token: Token<T> | Token<T, M>) => {
        if (!isToken(token)) throw usageError("createScope requires a Token.");
        let closed = false;
        const listeners = new Set<() => void>();
        const scope: ResourceScope = {
          id: `${id}:scope:${++scopeSequence}`,
          serviceId: token.id,
          get closed() {
            return closed;
          },
          close() {
            if (closed) return;
            closed = true;
            for (const listener of [...listeners]) {
              try {
                listener();
              } catch {
                // Scope observers are independent lifecycle consumers.
              }
            }
            listeners.clear();
          },
          onClosed(listener) {
            if (closed) {
              try {
                listener();
              } catch {
                // Late observer failures are isolated.
              }
              return () => undefined;
            }
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          [Symbol.dispose]() {
            this.close();
          },
        };
        scopes.add(scope);
        return scope;
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
        const scope = options.scope as ResourceScope | undefined;
        if (
          !isToken<T>(token) ||
          !isPlainObject(options) ||
          !Object.keys(options).every(
            (key) => key === "callTimeout" || key === "scope",
          ) ||
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
        if (scope?.closed)
          return err(
            new NexusResourceError(
              "The resource scope is closed.",
              "E_RESOURCE_SCOPE_CLOSED",
              { scopeId: scope.id, serviceName: scope.serviceId },
            ),
          ) as unknown as Result<Remote<T, M>, ResourceAcquireError>;
        if (scope && (!scopes.has(scope) || scope.serviceId !== token.id))
          return err(
            usageError("Scope belongs to a different connection or service."),
          );
        return ok(
          createInMemoryServiceProxy(
            provider.service as T,
            connection,
            options.callTimeout ?? callTimeout,
            token.id,
            scope,
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

  type MockAcquisitionSession = AcquisitionSession<M> & {
    readonly connection: Connection<M>;
  };
  /** Adapts mock facts to Core's acquisition rules without giving acquisition mock ownership. */
  const acquisitionSource = (): AcquisitionSource<
    M,
    MockAcquisitionSession
  > => {
    const sessions = () =>
      [...connectionHandles.values()].map((connection) => ({
        connection,
        connectionId: connection.id,
        remoteIdentity: connection.contextMeta,
        context: { connection: connection.connectionMeta },
        isReady: () => connection.status === "connected",
      }));
    return {
      findReadyConnections: sessions,
      safeResolveConnections: async ({ target }) => {
        const matching = sessions().filter((session) =>
          matchesTarget(session.connection, target),
        );
        return matching.length
          ? ok(matching)
          : err(
              new NexusServiceError(
                "Mock Nexus target has no matching connection.",
                "E_SERVICE_NO_MATCH",
                { context: { target } },
              ),
            );
      },
      subscribeAvailabilityChanged: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
    };
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
    const acquired = await safeAcquireConnection(async () => {
      connectCalls.push({ options });
      return ok(acquisitionSource());
    }, options);
    return acquired.map(({ connection }) => connection);
  };

  /** Captures a fixed snapshot of existing mock connections. */
  const safeConnectMulticast = async (
    options: ConnectMulticastOptions<M> = {},
  ): Promise<Result<ConnectionCollection<M>, Error>> => {
    const acquired = await safeAcquireConnections(async () => {
      connectMulticastCalls.push({ options });
      return ok(acquisitionSource());
    }, options);
    return acquired.map(
      (sessions) =>
        new ConnectionCollection(sessions.map(({ connection }) => connection)),
    );
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
        for (const connection of connectionHandles.values()) {
          if (
            connection.status !== "connected" ||
            (where && !where(connection.contextMeta, connection.connectionMeta))
          )
            continue;
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

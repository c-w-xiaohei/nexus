import { Result } from "better-result";
import type { LogicalConnection } from "@/connection/logical-connection";
import type { Engine } from "@/service/engine";
import {
  NexusDisconnectedError,
  NexusServiceError,
  NexusUsageError,
  type ResourceAcquireError,
} from "@/errors";
import type {
  AdapterModel,
  ContextMetaOf,
  ConnectionMetaOf,
} from "@/types/adapter-model";
import { Logger } from "@/logger";
import { Token } from "./token";
import type { Remote } from "./types";
import { hasOnlyOptionKeys, isValidTimeout } from "./types/config";

export type DisconnectReason = "local" | "remote" | "protocol";
export interface ResourceOptions {
  /** Positive finite local call budget, inherited by refs returned from this handle. */
  callTimeout?: number;
}

/** A shared session handle, not a lease. Dropping it never closes the session. */
export interface Connection<M extends AdapterModel = AdapterModel> {
  readonly id: string;
  readonly status: "connected" | "disconnected";
  readonly disconnectReason: DisconnectReason | undefined;
  readonly contextMeta: Readonly<ContextMetaOf<M>>;
  readonly connectionMeta: Readonly<ConnectionMetaOf<M>>;
  /** Checks the current catalog synchronously; never connects or waits for a provider. */
  get<T extends object>(
    token: Token<T> | Token<T, M>,
    options?: ResourceOptions,
  ): Remote<T, M>;
  /** Returns catalog or session errors without waiting for a future provider publication. */
  safeGet<T extends object>(
    token: Token<T> | Token<T, M>,
    options?: ResourceOptions,
  ): Result<Remote<T, M>, ResourceAcquireError>;
  /** Ends the whole shared session, not just this caller's interest. Idempotent. */
  disconnect(): void;
  /** Delivers the terminal reason once per subscription, including late subscribers. */
  onDisconnected(listener: (reason: DisconnectReason) => void): () => void;
  /** Delivers the current identity and every accepted update; ends on disconnect. */
  subscribeIdentity(
    listener: (meta: Readonly<ContextMetaOf<M>>) => void,
  ): () => void;
}

export class ConnectionHandle<
  M extends AdapterModel = AdapterModel,
> implements Connection<M> {
  private readonly disconnected = new Set<(reason: DisconnectReason) => void>();
  private readonly identities = new Set<
    (meta: Readonly<ContextMetaOf<M>>) => void
  >();
  private readonly logger = new Logger("L4 --- Connection");

  /** Binds a public handle to one immutable session identity and runtime call budget. */
  constructor(
    private readonly session: LogicalConnection<M>,
    private readonly engine: Engine<M>,
    private readonly callTimeout: number,
  ) {}

  /** Identifies this session, including after it has disconnected. */
  get id(): string {
    return this.session.connectionId;
  }
  /** Reflects the terminal connection state without initiating any transport work. */
  get status(): "connected" | "disconnected" {
    return this.session.isReady() ? "connected" : "disconnected";
  }
  /** Reports why the shared session closed, if it has reached its terminal state. */
  get disconnectReason(): DisconnectReason | undefined {
    return this.session.disconnectReason;
  }
  /** Reads the peer's most recently committed identity snapshot. */
  get contextMeta(): Readonly<ContextMetaOf<M>> {
    return this.session.remoteIdentity!;
  }
  /** Reads adapter-observed facts, independently of peer-declared metadata. */
  get connectionMeta() {
    return this.session.context.connection;
  }

  /** Creates a lightweight proxy from the current catalog or throws an acquisition error. */
  get<T extends object>(
    token: Token<T> | Token<T, M>,
    options?: ResourceOptions,
  ): Remote<T, M> {
    const result = this.safeGet(token, options);
    if (result.isErr()) throw result.error;
    return result.value;
  }

  /** Validates local options and catalog availability without dialing or waiting. */
  safeGet<T extends object>(
    token: Token<T> | Token<T, M>,
    options: ResourceOptions = {},
  ): Result<Remote<T, M>, ResourceAcquireError> {
    const context = { connectionId: this.id };
    if (
      !(token instanceof Token) ||
      !hasOnlyOptionKeys(options, ["callTimeout"]) ||
      !isValidTimeout(options.callTimeout)
    )
      return Result.err(
        new NexusUsageError(
          "get requires a Token and a positive finite callTimeout.",
          "E_USAGE_INVALID",
          { context },
        ),
      );
    if (this.status === "disconnected")
      return Result.err(
        new NexusDisconnectedError(
          "The session is disconnected.",
          "E_CONN_CLOSED",
          context,
        ),
      );
    if (!this.session.hasProvider(token.id))
      return Result.err(
        new NexusServiceError(
          `Service "${token.id}" is unavailable.`,
          "E_SERVICE_UNAVAILABLE",
          { context: { ...context, serviceName: token.id } },
        ),
      );
    return Result.ok(
      this.engine.createServiceProxy<Remote<T, M>>(token.id, {
        connectionId: this.id,
        timeout: options.callTimeout ?? this.callTimeout,
      }),
    );
  }

  /** Closes the whole shared session and invalidates all handles bound to it. */
  disconnect(): void {
    this.session.close();
  }

  /** Observes one terminal notification per registration, including late registrations. */
  onDisconnected(listener: (reason: DisconnectReason) => void): () => void {
    if (this.status === "disconnected") {
      this.notify(() => listener(this.disconnectReason!));
      return () => {};
    }
    /** Keeps repeated registrations of the same callback independently cancellable. */
    const notify = (reason: DisconnectReason) => listener(reason);
    this.disconnected.add(notify);
    return () => {
      this.disconnected.delete(notify);
    };
  }

  /** Delivers the current and every later committed identity until stopped or disconnected. */
  subscribeIdentity(
    listener: (meta: Readonly<ContextMetaOf<M>>) => void,
  ): () => void {
    if (this.status === "disconnected") return () => {};
    /** Gives this registration its own identity even when callbacks are reused. */
    const notify = (meta: Readonly<ContextMetaOf<M>>) => listener(meta);
    this.identities.add(notify);
    this.notify(() => listener(this.contextMeta));
    return () => {
      this.identities.delete(notify);
    };
  }

  /** @internal Called after L2 commits identity and L3 updates its dependents. */
  identityUpdated(meta: ContextMetaOf<M>): void {
    for (const listener of Array.from(this.identities)) {
      if (this.status === "connected" && this.identities.has(listener))
        this.notify(() => listener(meta));
    }
  }

  /** @internal Called after pending calls and references have been detached. */
  closed(): void {
    this.identities.clear();
    for (const listener of Array.from(this.disconnected)) {
      if (!this.disconnected.delete(listener)) continue;
      this.notify(() => listener(this.disconnectReason!));
    }
  }

  /** Isolates synchronous observer failures so other observers and cleanup still run. */
  private notify(listener: () => void): void {
    Result.try({ try: listener, catch: (error) => error }).match({
      ok: () => undefined,
      err: (error) => this.logger.error("Connection observer failed", error),
    });
  }
}

export type ConnectionResource<T extends object, M extends AdapterModel> = {
  readonly connection: Connection<M>;
  readonly result: Result<Remote<T, M>, ResourceAcquireError>;
};

/** A fixed, ordered snapshot. Closed members remain in the collection. */
export class ConnectionCollection<M extends AdapterModel = AdapterModel> {
  readonly connections: readonly Connection<M>[];
  /** Captures member order and identity without taking ownership of the sessions. */
  constructor(connections: readonly Connection<M>[]) {
    this.connections = Object.freeze([...new Set(connections)]);
  }
  /** Returns one source-associated Result for every member, including disconnected or missing providers. */
  get<T extends object>(
    token: Token<T> | Token<T, M>,
    options?: ResourceOptions,
  ): readonly ConnectionResource<T, M>[] {
    return this.connections.map((connection) => ({
      connection,
      result: connection.safeGet(token, options),
    }));
  }
}

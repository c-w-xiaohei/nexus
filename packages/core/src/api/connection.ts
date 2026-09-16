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
import { Token } from "./token";
import type { Remote } from "./types";
import { hasOnlyOptionKeys, isValidTimeout } from "./types/config";
import { Logger } from "@/logger";

const logger = new Logger("L4 --- Connection");

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
  /** Public late-subscription behavior; live delivery uses the session event directly. */
  readonly onDisconnected: Connection<M>["onDisconnected"] = (listener) => {
    const reason = this.disconnectReason;
    if (reason === undefined) return this.session.onDisconnected(listener);
    try {
      listener(reason);
    } catch (error) {
      logger.error("Disconnect observer failed", error);
    }
    return () => {};
  };

  /** Public current-value delivery; no additional listener collection or event hop. */
  readonly subscribeIdentity: Connection<M>["subscribeIdentity"] = (
    listener,
  ) => {
    if (!this.session.isReady()) return () => {};
    const stop = this.session.subscribeIdentity(listener);
    try {
      listener(this.contextMeta);
    } catch (error) {
      logger.error("Identity observer failed", error);
    }
    return stop;
  };

  /** Binds a public handle to one immutable session identity and runtime call budget. */
  constructor(
    private readonly session: LogicalConnection<M>,
    private readonly engine: Pick<Engine<M>, "createServiceProxy">,
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

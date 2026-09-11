import type { Token } from "../api/token";
import type { AdapterModel } from "../types/adapter-model";
import type { ZodType } from "zod";
import type { StoreApi } from "zustand/vanilla";
import type { SyncEnvelope, TerminalReason } from "./protocol";

export type ActionFunction = (...args: any[]) => any;

export type ActionArgs<
  TActions extends Record<string, ActionFunction>,
  K extends keyof TActions,
> = Parameters<TActions[K]>;

export type ActionResult<
  TActions extends Record<string, ActionFunction>,
  K extends keyof TActions,
> = Awaited<ReturnType<TActions[K]>>;

export type RemoteActions<TActions extends Record<string, ActionFunction>> = {
  [K in keyof TActions]: (
    ...args: ActionArgs<TActions, K>
  ) => Promise<ActionResult<TActions, K>>;
};

export type NexusStoreValidationSchemas<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> = {
  state?: ZodType<TState>;
  actionResults?: {
    [K in keyof TActions]?: ZodType<ActionResult<TActions, K>>;
  };
};

/**
 * One callback channel carries initialization, published snapshots and termination.
 * Resolving the callback acknowledges receipt/application; rejecting init stops the
 * subscription. The init event supplies actions and an idempotent unsubscribe.
 */
export type NexusStoreServiceContract<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> = {
  subscribe(
    onSync: (event: SyncEnvelope<TState, TActions>) => void | Promise<void>,
  ): Promise<void>;
};

/** Shared contract and validation only; the Zustand creator stays in the host. */
export interface NexusStoreDefinition<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel = AdapterModel,
> {
  token:
    | Token<NexusStoreServiceContract<TState, TActions>, M>
    | Token<NexusStoreServiceContract<TState, TActions>>;
  validation?: NexusStoreValidationSchemas<TState, TActions>;
}

export type RemoteStoreStatus =
  | { type: "initializing" }
  | { type: "ready"; storeInstanceId: string; version: number }
  | {
      type: "disconnected";
      lastKnownVersion: number | null;
      cause?: Error;
    }
  | {
      type: "stale";
      lastKnownVersion: number | null;
      reason: TerminalReason;
    }
  | { type: "destroyed" };

export interface RemoteStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> extends StoreHandle<TState, TActions> {
  getStatus(): RemoteStoreStatus;
  /** Observes lifecycle and version changes with atomically visible state/status. */
  subscribeStatus(listener: () => void): () => void;
}

/** Session-bound mirror interface; local hosts expose their original Zustand API. */
export interface StoreHandle<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> extends Disposable {
  /** Reads committed data. The remote mirror remains synchronous for local consumers. */
  getState(): TState;
  /** Stable initial snapshot for this session. Treat it as immutable. */
  getInitialState(): TState;
  /** Zustand-compatible changes; init observers receive the baseline as both values. */
  subscribe: StoreApi<TState>["subscribe"];
  /** Stops observation and releases subscription capabilities; safe to call repeatedly. */
  destroy(): void;
  /** Successful remote actions wait for this handle's captured publication batch. */
  readonly actions: RemoteActions<TActions>;
}

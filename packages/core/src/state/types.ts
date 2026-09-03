import type { Token } from "@/api/token";
import type { CreateOptions } from "@/api/types/config";
import type { AdapterModel } from "@/types/adapter-model";
import type { ZodType } from "zod";
import type {
  ConnectNexusStoreOptionsInput,
  DispatchResultEnvelope,
  SnapshotEnvelope,
  SubscribeResult,
  TerminalEnvelope,
  TerminalReason,
} from "./protocol";
import type { ServiceInvocationContext } from "@/service/service-invocation-hooks";

export type ActionFunction = (...args: any[]) => any;

export type StoreTokenMetadata<TToken> =
  TToken extends Token<infer _T, infer M> ? M : never;

export type ActionArgs<
  TActions extends Record<string, ActionFunction>,
  K extends keyof TActions,
> = TActions[K] extends (...args: infer TArgs) => any ? TArgs : never;

export type ActionResult<
  TActions extends Record<string, ActionFunction>,
  K extends keyof TActions,
> = TActions[K] extends (...args: any[]) => infer TResult
  ? Awaited<TResult>
  : never;

export type RemoteActions<TActions extends Record<string, ActionFunction>> = {
  [K in keyof TActions]: (
    ...args: Parameters<TActions[K]>
  ) => Promise<Awaited<ReturnType<TActions[K]>>>;
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

export interface StoreActionHelpers<TState extends object> {
  getState(): TState;
  setState(nextState: TState): void;
  setState(updater: (currentState: TState) => TState): void;
}

export interface NexusStoreServiceContract<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> {
  subscribe(
    onSync: (
      event:
        | (Omit<SnapshotEnvelope, "state"> & { state: TState })
        | TerminalEnvelope,
    ) => void,
  ): Promise<Omit<SubscribeResult, "state"> & { state: TState }>;
  unsubscribe(subscriptionId: string): Promise<void>;
  dispatch<K extends keyof TActions & string>(
    action: K,
    args: ActionArgs<TActions, K>,
    invocationContext?: ServiceInvocationContext,
  ): Promise<{
    type: DispatchResultEnvelope["type"];
    committedVersion: DispatchResultEnvelope["committedVersion"];
    result: ActionResult<TActions, K>;
  }>;
}

export interface NexusStoreDefinition<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel = AdapterModel,
> {
  token:
    | Token<NexusStoreServiceContract<TState, TActions>, M>
    | Token<NexusStoreServiceContract<TState, TActions>>;
  state: () => TState;
  actions: (helpers: StoreActionHelpers<TState>) => TActions;
  sync?: {
    mode?: "snapshot";
  };
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
      reason: "target-changed" | TerminalReason;
    }
  | { type: "destroyed" };

export interface RemoteStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> {
  getState(): TState;
  subscribe(listener: (state: TState) => void): () => void;
  getStatus(): RemoteStoreStatus;
  /**
   * Observes future status invalidations. Unsubscribing prevents future calls,
   * and an observer error does not prevent other observers from running.
   */
  subscribeStatus?(listener: () => void): () => void;
  destroy(): void;
  readonly actions: RemoteActions<TActions>;
}

/** A Core 1.1 remote Store handle returned by Nexus State acquisition APIs. */
export interface RemoteStoreWithInitialState<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
>
  extends RemoteStore<TState, TActions>, Disposable {
  getInitialState(): TState;
  [Symbol.dispose](): void;
}

export interface ConnectNexusStoreOptions<
  M extends AdapterModel = AdapterModel,
> extends Omit<ConnectNexusStoreOptionsInput, "target"> {
  target?: CreateOptions<M>["target"];
  where?: CreateOptions<M>["where"];
}

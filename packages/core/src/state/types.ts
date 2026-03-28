import type { Token } from "@/api/token";
import type { CreateOptions } from "@/api/types/config";
import type { UserMetadata } from "@/types/identity";
import type {
  ConnectNexusStoreOptionsInput,
  DispatchResultEnvelope,
  SnapshotEnvelope,
  SubscribeResult,
} from "./protocol";

type ActionFunction = (...args: any[]) => any;

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
      event: Omit<SnapshotEnvelope, "state"> & { state: TState },
    ) => void,
  ): Promise<Omit<SubscribeResult, "state"> & { state: TState }>;
  unsubscribe(subscriptionId: string): Promise<void>;
  dispatch<K extends keyof TActions & string>(
    action: K,
    args: ActionArgs<TActions, K>,
  ): Promise<{
    type: DispatchResultEnvelope["type"];
    committedVersion: DispatchResultEnvelope["committedVersion"];
    result: ActionResult<TActions, K>;
  }>;
}

export interface NexusStoreDefinition<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> {
  token: Token<NexusStoreServiceContract<TState, TActions>>;
  state: () => TState;
  actions: (helpers: StoreActionHelpers<TState>) => TActions;
  sync?: {
    mode?: "snapshot";
  };
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
      reason: "target-changed";
    }
  | { type: "destroyed" };

export interface RemoteStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> {
  getState(): TState;
  subscribe(listener: (state: TState) => void): () => void;
  getStatus(): RemoteStoreStatus;
  destroy(): void;
  readonly actions: TActions;
}

export interface ConnectNexusStoreOptions<
  U extends UserMetadata = UserMetadata,
  M extends string = string,
  D extends string = string,
> extends Omit<ConnectNexusStoreOptionsInput, "target"> {
  target?: CreateOptions<U, M, D>["target"];
}

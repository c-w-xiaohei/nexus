import { Token } from "../api/token";
import type { AdapterModel } from "../types/adapter-model";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { StoreApi } from "zustand/vanilla";
import type { SyncEnvelope, TerminalReason } from "./protocol";

type ActionFunction = (...args: any[]) => any;

export type StoreActionKeys<Store extends object> = {
  [K in keyof Store]-?: Store[K] extends ActionFunction ? K : never;
}[keyof Store] &
  string;

export type StoreData<Store extends object> = {
  [K in keyof Store as Store[K] extends ActionFunction ? never : K]: Store[K];
};

export type RemoteActions<Store extends object> = {
  [K in StoreActionKeys<Store>]: Store[K] extends ActionFunction
    ? (...args: Parameters<Store[K]>) => Promise<Awaited<ReturnType<Store[K]>>>
    : never;
};

export type StoreValidationSchemas<Store extends object> = {
  /** Output compatibility only; runtime input is always unknown. */
  state?: StandardSchemaV1<unknown, StoreData<Store>>;
  actionResults?: {
    [K in StoreActionKeys<Store>]?: Store[K] extends ActionFunction
      ? StandardSchemaV1<unknown, Awaited<ReturnType<Store[K]>>>
      : never;
  };
};

/** One callback carries initialization, snapshots, and terminal state. */
export type NexusStoreServiceContract<Store extends object> = {
  subscribe(
    onSync: (
      event: SyncEnvelope<StoreData<Store>, Store>,
    ) => void | Promise<void>,
  ): Promise<void>;
};

/** A State token carries shared wire validation independently of connection acquisition. */
export class StoreToken<
  Store extends object,
  M extends AdapterModel | never = never,
> extends Token<NexusStoreServiceContract<Store>, M> {
  readonly validation?: StoreValidationSchemas<Store>;

  /** Creates a shared State service identifier with optional validation schemas. */
  constructor(
    id: string,
    options?: {
      validation?: StoreValidationSchemas<Store>;
    },
  ) {
    super(id);
    this.validation = options?.validation;
  }
}

/** Creates a typed State contract without choosing or connecting to a provider. */
export const createStoreToken = <
  Store extends object,
  M extends AdapterModel | never = never,
>(
  id: string,
  options?: { validation?: StoreValidationSchemas<Store> },
): StoreToken<Store, M> => new StoreToken(id, options);

export type RemoteStoreStatus =
  | { type: "initializing" }
  | { type: "ready"; storeInstanceId: string; version: number }
  | { type: "disconnected"; lastKnownVersion: number | null; cause?: Error }
  | { type: "stale"; lastKnownVersion: number | null; reason: TerminalReason }
  | { type: "destroyed" };

export interface RemoteStore<Store extends object> extends StoreHandle<Store> {
  getStatus(): RemoteStoreStatus;
  subscribeStatus(listener: () => void): () => void;
}

/** Session-bound mirror interface; local hosts retain their native Zustand API. */
export interface StoreHandle<Store extends object> extends Disposable {
  getState(): StoreData<Store>;
  getInitialState(): StoreData<Store>;
  subscribe: StoreApi<StoreData<Store>>["subscribe"];
  destroy(): void;
  readonly actions: RemoteActions<Store>;
}

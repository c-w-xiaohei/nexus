import { Token, type TokenOptions } from "../api/token";
import type { AdapterModel } from "../types/adapter-model";
import type { ZodType } from "zod";
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
  state?: ZodType<StoreData<Store>>;
  actionResults?: {
    [K in StoreActionKeys<Store>]?: Store[K] extends ActionFunction
      ? ZodType<Awaited<ReturnType<Store[K]>>>
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

/** A State token carries shared wire validation while retaining Core Token targeting. */
export class StoreToken<
  Store extends object,
  M extends AdapterModel | never = never,
> extends Token<NexusStoreServiceContract<Store>, M> {
  readonly validation?: StoreValidationSchemas<Store>;

  constructor(
    id: string,
    options?: TokenOptions<M & AdapterModel> & {
      validation?: StoreValidationSchemas<Store>;
    },
  ) {
    super(id, options);
    this.validation = options?.validation;
  }
}

export const createStoreToken = <
  Store extends object,
  M extends AdapterModel | never = never,
>(
  id: string,
  options?: TokenOptions<M & AdapterModel> & {
    validation?: StoreValidationSchemas<Store>;
  },
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

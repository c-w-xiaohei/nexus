import { Token } from "@nexus-js/core";
import { createStoreToken } from "@nexus-js/core/state";

export const APP_ID = "react-state-star-browser";
export const HOST_ORIGIN = "http://127.0.0.1:3310";
export const CHILD_ORIGIN = "http://127.0.0.1:3311";
export const FRAME_IDS = ["alpha", "beta"] as const;
export type FrameId = (typeof FRAME_IDS)[number];

export const RELAY_APP_ID = "react-relay-browser";
export const RELAY_HOST_ORIGIN = HOST_ORIGIN;
export const RELAY_ORIGIN = CHILD_ORIGIN;
export const RELAY_FRAME_ID = "relay";
export const RELAY_CHILD_IDS = ["leaf-a", "leaf-b"] as const;
export type RelayChildId = (typeof RELAY_CHILD_IDS)[number];

export interface RelayProfileService {
  profile: {
    read(childId: string): Promise<{ childId: string; servedBy: string }>;
    failWithCode(code: string): Promise<never>;
  };
}

export const RelayProfileToken = new Token<RelayProfileService>(
  "react.browser.relay.profile",
);

export interface CounterWrite {
  readonly actor: string;
  readonly op: string;
  readonly value: number;
}

export interface CounterState {
  readonly count: number;
  readonly writes: CounterWrite[];
}

export type CounterActions = {
  increment(actor: string, by: number): number;
  setCount(actor: string, value: number): number;
  asyncIncrementSlow(
    actor: string,
    by: number,
    delayMs: number,
  ): Promise<number>;
  failAfterNoCommit(actor: string): Promise<void>;
};

export type CounterStore = CounterState & CounterActions;

export const CounterStoreToken = createStoreToken<CounterStore>(
  "react.browser.counter-store",
);

export const counterStore = CounterStoreToken;

export const createCounterStoreCreator =
  (initialCount = 0) =>
  (set: (state: Partial<CounterStore>) => void, get: () => CounterStore) => ({
    count: initialCount,
    writes: [] as CounterWrite[],
    increment(actor: string, by: number) {
      const current = get();
      const count = current.count + by;
      set({
        count,
        writes: [...current.writes, { actor, op: "increment", value: by }],
      });
      return count;
    },
    setCount(actor: string, value: number) {
      const current = get();
      set({
        count: value,
        writes: [...current.writes, { actor, op: "setCount", value }],
      });
      return value;
    },
    async asyncIncrementSlow(actor: string, by: number, delayMs: number) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const current = get();
      const count = current.count + by;
      set({
        count,
        writes: [...current.writes, { actor, op: "slow", value: by }],
      });
      return count;
    },
    async failAfterNoCommit(actor: string) {
      const current = get();
      set({
        count: current.count + 10_000,
        writes: [...current.writes, { actor, op: "rollback", value: 10_000 }],
      });
      throw new Error(`fail:${actor}`);
    },
  });

export const iframeCounterStore = counterStore;

export const hostTarget = {
  context: "iframe-parent",
  appId: APP_ID,
} as const;

export const relayHostTarget = {
  context: "iframe-parent",
  appId: RELAY_APP_ID,
  origin: RELAY_HOST_ORIGIN,
} as const;

export const relayFrameTarget = {
  context: "iframe-parent",
  appId: RELAY_APP_ID,
  origin: RELAY_ORIGIN,
} as const;

export const childTarget = (frameId: string) => ({
  context: "iframe-child",
  appId: APP_ID,
  frameId,
});

export const frameNonce = (frameId: string) =>
  `react-state-star-nonce-${frameId}`;

export const relayFrameNonce = () => `react-relay-nonce-${RELAY_FRAME_ID}`;

export const relayChildNonce = (childId: string) =>
  `react-relay-child-nonce-${childId}`;

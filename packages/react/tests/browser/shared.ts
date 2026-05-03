import { Token } from "@nexus-js/core";
import {
  defineNexusStore,
  type NexusStoreServiceContract,
} from "@nexus-js/core/state";

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

export type CounterActions = Record<string, (...args: any[]) => any> & {
  increment(actor: string, by: number): number;
  setCount(actor: string, value: number): number;
  asyncIncrementSlow(
    actor: string,
    by: number,
    delayMs: number,
  ): Promise<number>;
  failAfterNoCommit(actor: string): Promise<void>;
};

export const CounterStoreToken = new Token<
  NexusStoreServiceContract<CounterState, CounterActions>
>("react.browser.counter-store");

export const counterStore = defineNexusStore<CounterState, CounterActions>({
  token: CounterStoreToken,
  state: () => ({ count: 0, writes: [] }),
  actions: ({ getState, setState }) => ({
    increment(actor, by) {
      const current = getState();
      const count = current.count + by;
      setState({
        count,
        writes: [...current.writes, { actor, op: "increment", value: by }],
      });
      return count;
    },
    setCount(actor, value) {
      const current = getState();
      setState({
        count: value,
        writes: [...current.writes, { actor, op: "setCount", value }],
      });
      return value;
    },
    async asyncIncrementSlow(actor, by, delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const current = getState();
      const count = current.count + by;
      setState({
        count,
        writes: [...current.writes, { actor, op: "slow", value: by }],
      });
      return count;
    },
    async failAfterNoCommit(actor) {
      const current = getState();
      setState({
        count: current.count + 10_000,
        writes: [...current.writes, { actor, op: "rollback", value: 10_000 }],
      });
      throw new Error(`fail:${actor}`);
    },
  }),
});

export const hostTarget = {
  descriptor: { context: "iframe-parent", appId: APP_ID },
} as const;

export const relayHostTarget = {
  descriptor: {
    context: "iframe-parent",
    appId: RELAY_APP_ID,
    origin: RELAY_HOST_ORIGIN,
  },
} as const;

export const relayFrameTarget = {
  descriptor: {
    context: "iframe-parent",
    appId: RELAY_APP_ID,
    origin: RELAY_ORIGIN,
  },
} as const;

export const childDescriptor = (frameId: string) => ({
  context: "iframe-child",
  appId: APP_ID,
  frameId,
});

export const frameNonce = (frameId: string) =>
  `react-state-star-nonce-${frameId}`;

export const relayFrameNonce = () => `react-relay-nonce-${RELAY_FRAME_ID}`;

export const relayChildNonce = (childId: string) =>
  `react-relay-child-nonce-${childId}`;

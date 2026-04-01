/**
 * Simulates store protocol failures and in-flight transport loss to confirm
 * Nexus maps malformed handshakes, connect timeouts, and unknown-commit races
 * into stable client-visible error classes at the state API boundary.
 */
import { describe, expect, it } from "vitest";

import { Token } from "../../src/api/token";
import { createStarNetwork } from "../../src/utils/test-utils";
import {
  connectNexusStore,
  defineNexusStore,
  NexusStoreConnectError,
  NexusStoreProtocolError,
  provideNexusStore,
} from "../../src/state";

describe("Nexus State Integration: Protocol and Error Classification", () => {
  it("classifies malformed baseline and handshake timeout at L4", async () => {
    type CounterState = { count: number };
    type CounterActions = { noop(): number };

    const definition = defineNexusStore<CounterState, CounterActions>({
      token: new Token("state:counter:handshake-classification:integration"),
      state: () => ({ count: 0 }),
      actions: () => ({ noop: () => 0 }),
    });

    const malformedService = {
      async subscribe(_onSync: (event: unknown) => void) {
        return {
          storeInstanceId: "store-malformed",
          subscriptionId: "sub-malformed",
          version: "not-a-number",
          state: { count: 0 },
        };
      },
      async unsubscribe(_subscriptionId: string) {
        return;
      },
      async dispatch(_action: "noop", _args: []) {
        return {
          type: "dispatch-result" as const,
          committedVersion: 1,
          result: 0,
        };
      },
    };

    const timeoutService = {
      async subscribe(_onSync: (event: unknown) => void) {
        return new Promise<never>(() => undefined);
      },
      async unsubscribe(_subscriptionId: string) {
        return;
      },
      async dispatch(_action: "noop", _args: []) {
        return {
          type: "dispatch-result" as const,
          committedVersion: 1,
          result: 0,
        };
      },
    };

    const malformedNetwork = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [definition.token.id]: malformedService,
        },
      },
      leaves: [
        {
          meta: { context: "popup" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const malformedPopup = malformedNetwork.get("popup")!.nexus;
    await expect(
      connectNexusStore(malformedPopup, definition, {
        target: { descriptor: { context: "background" } },
      }),
    ).rejects.toBeInstanceOf(NexusStoreProtocolError);

    const timeoutNetwork = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [definition.token.id]: timeoutService,
        },
      },
      leaves: [
        {
          meta: { context: "popup" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const timeoutPopup = timeoutNetwork.get("popup")!.nexus;
    await expect(
      connectNexusStore(timeoutPopup, definition, {
        target: { descriptor: { context: "background" } },
        timeout: 30,
      }),
    ).rejects.toBeInstanceOf(NexusStoreConnectError);
  });

  it("returns unknown-commit disconnect semantics when transport drops during in-flight action", async () => {
    type CounterState = { count: number };
    type CounterActions = { increment(by: number): Promise<number> };

    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const counterStore = defineNexusStore<CounterState, CounterActions>({
      token: new Token("state:counter:inflight-disconnect:integration"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        async increment(by: number) {
          markStarted();
          await gate;
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
    });

    const network = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [counterStore.token.id]:
            provideNexusStore(counterStore).implementation,
        },
      },
      leaves: [
        {
          meta: { context: "popup" },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const popup = network.get("popup")!.nexus;
    const remote = await connectNexusStore(popup, counterStore, {
      target: { descriptor: { context: "background" } },
    });

    const pending = remote.actions.increment(1);
    await started;

    const popupCm = (popup as any).connectionManager;
    const connection = Array.from((popupCm as any).connections.values())[0] as {
      close(): void;
    };
    connection.close();
    resolveGate();

    await expect(pending).rejects.toMatchObject({
      name: "NexusStoreDisconnectedError",
      message: expect.stringMatching(/unknown commit/i),
    });
    expect(remote.getStatus().type).toBe("disconnected");
  });
});

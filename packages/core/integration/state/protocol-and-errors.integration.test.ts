/**
 * Simulates store protocol failures and in-flight transport loss to confirm
 * Nexus maps malformed handshakes, connect timeouts, and unknown-commit races
 * into stable client-visible error classes at the state API boundary.
 */
import { describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import type { IPort } from "../../src/transport";
import { createStarNetwork } from "../../src/utils/test-utils";
import { createMockPortPair } from "../../src/utils/test-utils";
import {
  connectNexusStore,
  defineNexusStore,
  NexusStoreConnectError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
  provideNexusStore,
} from "../../src/state";

type HandshakeCounterState = { count: number };
type HandshakeCounterActions = { noop(): Promise<number> };
type HandshakeUserMeta = { context: "background" | "popup" };
type HandshakePlatformMeta = { from: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface ControlledConnectionPorts {
  popupPort: IPort;
  backgroundPort: IPort;
  holdBackgroundToPopup(): void;
  flushBackgroundToPopup(): void;
  queuedBackgroundToPopupCount(): number;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const createControlledConnectionPorts = (): ControlledConnectionPorts => {
  let popupMessageHandler: ((msg: unknown) => void) | undefined;
  let backgroundMessageHandler: ((msg: unknown) => void) | undefined;
  let popupDisconnectHandler: (() => void) | undefined;
  let backgroundDisconnectHandler: (() => void) | undefined;
  let holdBackgroundToPopup = false;
  const backgroundToPopupQueue: unknown[] = [];

  const popupPort: IPort = {
    postMessage: vi.fn((msg: unknown) => {
      setTimeout(() => backgroundMessageHandler?.(msg), 0);
    }),
    onMessage: vi.fn((handler: (msg: unknown) => void) => {
      popupMessageHandler = handler;
    }),
    onDisconnect: vi.fn((handler: () => void) => {
      popupDisconnectHandler = handler;
    }),
    close: vi.fn(() => {
      popupDisconnectHandler?.();
      backgroundDisconnectHandler?.();
    }),
  };

  const backgroundPort: IPort = {
    postMessage: vi.fn((msg: unknown) => {
      if (holdBackgroundToPopup) {
        backgroundToPopupQueue.push(msg);
        return;
      }
      setTimeout(() => popupMessageHandler?.(msg), 0);
    }),
    onMessage: vi.fn((handler: (msg: unknown) => void) => {
      backgroundMessageHandler = handler;
    }),
    onDisconnect: vi.fn((handler: () => void) => {
      backgroundDisconnectHandler = handler;
    }),
    close: vi.fn(() => {
      popupDisconnectHandler?.();
      backgroundDisconnectHandler?.();
    }),
  };

  return {
    popupPort,
    backgroundPort,
    holdBackgroundToPopup() {
      holdBackgroundToPopup = true;
    },
    flushBackgroundToPopup() {
      const queued = backgroundToPopupQueue.splice(0);
      holdBackgroundToPopup = false;
      for (const msg of queued) {
        setTimeout(() => popupMessageHandler?.(msg), 0);
      }
    },
    queuedBackgroundToPopupCount() {
      return backgroundToPopupQueue.length;
    },
  };
};

const createBackgroundHost = async (
  tokenId: string,
  service: object,
): Promise<{
  nexus: Nexus<HandshakeUserMeta, HandshakePlatformMeta>;
  acceptConnection(port: { onMessage: unknown }): void;
  closeAllConnections(): void;
}> => {
  const nexus = new Nexus<HandshakeUserMeta, HandshakePlatformMeta>();
  let listenCallback:
    | ((port: any, platformMeta?: HandshakePlatformMeta) => void)
    | undefined;

  nexus.configure({
    endpoint: {
      meta: { context: "background" },
      implementation: {
        listen: vi.fn((onConnect) => {
          listenCallback = onConnect;
        }),
        connect: vi.fn(async () => {
          throw new Error("Background does not initiate connections here.");
        }),
      },
    },
    services: [{ token: new Token(tokenId), implementation: service }],
  });

  await vi.waitFor(() => {
    expect((nexus as any).connectionManager).toBeTruthy();
  });

  return {
    nexus,
    acceptConnection(port) {
      if (!listenCallback) {
        throw new Error("Background listener is not ready.");
      }
      listenCallback(port, { from: "popup" });
    },
    closeAllConnections() {
      const cm = (nexus as any).connectionManager;
      if (!cm) {
        return;
      }
      const connections = Array.from(
        (cm as any).connections.values(),
      ) as Array<{
        close(): void;
      }>;
      for (const connection of connections) {
        connection.close();
      }
    },
  };
};

const createPopupNexus = async (
  resolveBackground: () => {
    acceptConnection(port: { onMessage: unknown }): void;
  },
  options?: {
    createPorts?: () => [IPort, IPort];
  },
) => {
  const popup = new Nexus<HandshakeUserMeta, HandshakePlatformMeta>();

  popup.configure({
    endpoint: {
      meta: { context: "popup" },
      implementation: {
        listen: vi.fn(),
        connect: vi.fn(
          async (_targetDescriptor: Partial<HandshakeUserMeta>) => {
            const [popupPort, backgroundPort] =
              options?.createPorts?.() ?? createMockPortPair();
            resolveBackground().acceptConnection(backgroundPort as any);
            return [popupPort, { from: "background" }] as [
              IPort,
              HandshakePlatformMeta,
            ];
          },
        ),
      },
      connectTo: [{ descriptor: { context: "background" } }],
    },
  });

  await vi.waitFor(() => {
    expect((popup as any).connectionManager).toBeTruthy();
  });

  return popup;
};

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

  it("does not hang or leak late old-session baseline across replacement handshake", async () => {
    const definition = defineNexusStore<
      HandshakeCounterState,
      HandshakeCounterActions
    >({
      token: new Token("state:counter:handshake-session-drop:integration"),
      state: () => ({ count: 0 }),
      actions: () => ({
        noop: async () => 0,
      }),
    });

    const oldSubscribeGate = deferred<void>();
    const oldSubscribeStarted = deferred<void>();
    const oldConnectionPorts = createControlledConnectionPorts();
    let connectionAttempt = 0;
    const oldSubscriptions = new Map<
      string,
      (event: {
        type: "snapshot";
        storeInstanceId: string;
        version: number;
        state: HandshakeCounterState;
      }) => void
    >();

    const oldService = {
      async subscribe(
        onSync: (event: {
          type: "snapshot";
          storeInstanceId: string;
          version: number;
          state: HandshakeCounterState;
        }) => void,
      ) {
        oldSubscribeStarted.resolve(undefined);
        await oldSubscribeGate.promise;

        const subscriptionId = "old-sub:1";
        oldSubscriptions.set(subscriptionId, onSync);
        return {
          storeInstanceId: "store-session:v1",
          subscriptionId,
          version: 41,
          state: { count: 41 },
        };
      },
      async unsubscribe(subscriptionId: string) {
        oldSubscriptions.delete(subscriptionId);
      },
      async dispatch(_action: "noop", _args: []) {
        return {
          type: "dispatch-result" as const,
          committedVersion: 42,
          result: 42,
        };
      },
    };

    let freshCount = 7;
    const freshSubscriptions = new Map<
      string,
      (event: {
        type: "snapshot";
        storeInstanceId: string;
        version: number;
        state: HandshakeCounterState;
      }) => void
    >();

    const replacementService = {
      async subscribe(
        onSync: (event: {
          type: "snapshot";
          storeInstanceId: string;
          version: number;
          state: HandshakeCounterState;
        }) => void,
      ) {
        const subscriptionId = "fresh-sub:1";
        freshSubscriptions.set(subscriptionId, onSync);
        return {
          storeInstanceId: "store-session:v2",
          subscriptionId,
          version: freshCount,
          state: { count: freshCount },
        };
      },
      async unsubscribe(subscriptionId: string) {
        freshSubscriptions.delete(subscriptionId);
      },
      async dispatch(_action: "noop", _args: []) {
        freshCount += 1;
        for (const callback of freshSubscriptions.values()) {
          callback({
            type: "snapshot",
            storeInstanceId: "store-session:v2",
            version: freshCount,
            state: { count: freshCount },
          });
        }
        return {
          type: "dispatch-result" as const,
          committedVersion: freshCount,
          result: freshCount,
        };
      },
    };

    let activeBackground = await createBackgroundHost(
      definition.token.id,
      oldService,
    );
    const popup = await createPopupNexus(() => activeBackground, {
      createPorts: () => {
        connectionAttempt += 1;
        if (connectionAttempt === 1) {
          return [
            oldConnectionPorts.popupPort,
            oldConnectionPorts.backgroundPort,
          ];
        }
        return createMockPortPair();
      },
    });

    const pendingOldConnect = connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
      timeout: 1200,
    });
    void pendingOldConnect.catch(() => undefined);

    await oldSubscribeStarted.promise;
    oldConnectionPorts.holdBackgroundToPopup();
    oldSubscribeGate.resolve(undefined);
    await vi.waitFor(() => {
      expect(oldConnectionPorts.queuedBackgroundToPopupCount()).toBeGreaterThan(
        0,
      );
    });

    activeBackground.closeAllConnections();
    activeBackground = await createBackgroundHost(
      definition.token.id,
      replacementService,
    );

    const popupCm = (popup as any).connectionManager;
    await vi.waitFor(() => {
      expect((popupCm as any).connections.size).toBe(0);
    });

    const replacementHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
      timeout: 250,
    });

    expect(replacementHandle.getState().count).toBe(7);

    const replacementSeen: number[] = [];
    const stopReplacement = replacementHandle.subscribe((snapshot) => {
      replacementSeen.push(snapshot.count);
    });

    await expect(replacementHandle.actions.noop()).resolves.toBe(8);
    await vi.waitFor(() => {
      expect(replacementHandle.getState().count).toBe(8);
      expect(replacementSeen).toEqual([8]);
    });

    oldConnectionPorts.flushBackgroundToPopup();

    await expect(pendingOldConnect).rejects.toMatchObject({
      name: NexusStoreDisconnectedError.name,
      message: expect.stringMatching(/disconnected|closed|stale/i),
    });

    expect(replacementHandle.getState().count).toBe(8);
    expect(replacementSeen).toEqual([8]);

    stopReplacement();
  });
});

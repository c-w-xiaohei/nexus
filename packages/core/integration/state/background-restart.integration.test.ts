import { describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import type { IPort } from "../../src/transport";
import { createMockPortPair } from "../../src/utils/test-utils";
import {
  connectNexusStore,
  defineNexusStore,
  NexusStoreDisconnectedError,
} from "../../src/state";

type CounterState = { count: number };
type CounterActions = { increment(by: number): Promise<number> };
type UserMeta = { context: "background" | "popup" };
type PlatformMeta = { from: string };

interface SnapshotEvent {
  type: "snapshot";
  storeInstanceId: string;
  version: number;
  state: CounterState;
}

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

const createStoreService = (options: {
  storeInstanceId: string;
  gate?: Promise<void>;
  onDispatchStarted?: () => void;
  onDispatchBeforeCommit?: (emitSnapshot: () => void) => void;
}) => {
  let version = 0;
  let state: CounterState = { count: 0 };
  const subscriptions = new Map<string, (event: SnapshotEvent) => void>();
  let subscriptionSeq = 0;

  return {
    async subscribe(onSync: (event: SnapshotEvent) => void) {
      const subscriptionId = `${options.storeInstanceId}:sub:${++subscriptionSeq}`;
      subscriptions.set(subscriptionId, onSync);
      return {
        storeInstanceId: options.storeInstanceId,
        subscriptionId,
        version,
        state,
      };
    },
    async unsubscribe(subscriptionId: string) {
      subscriptions.delete(subscriptionId);
    },
    async dispatch(_action: "increment", args: [number]) {
      options.onDispatchStarted?.();
      const nextState = { count: state.count + args[0] };
      const nextVersion = version + 1;
      const emitSnapshot = () => {
        const event: SnapshotEvent = {
          type: "snapshot",
          storeInstanceId: options.storeInstanceId,
          version: nextVersion,
          state: nextState,
        };

        for (const callback of subscriptions.values()) {
          callback(event);
        }
      };

      options.onDispatchBeforeCommit?.(emitSnapshot);
      await options.gate;

      state = nextState;
      version = nextVersion;
      emitSnapshot();

      return {
        type: "dispatch-result" as const,
        committedVersion: version,
        result: state.count,
      };
    },
  };
};

const createBackgroundHost = async (
  tokenId: string,
  service: object,
): Promise<{
  nexus: Nexus<UserMeta, PlatformMeta>;
  acceptConnection(port: { onMessage: unknown }): void;
  closeAllConnections(): void;
}> => {
  const nexus = new Nexus<UserMeta, PlatformMeta>();
  let listenCallback:
    | ((port: any, platformMeta?: PlatformMeta) => void)
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
  const popup = new Nexus<UserMeta, PlatformMeta>();

  popup.configure({
    endpoint: {
      meta: { context: "popup" },
      implementation: {
        listen: vi.fn(),
        connect: vi.fn(async (_targetDescriptor: Partial<UserMeta>) => {
          const [popupPort, backgroundPort] =
            options?.createPorts?.() ?? createMockPortPair();
          resolveBackground().acceptConnection(backgroundPort as any);
          return [popupPort, { from: "background" }] as [IPort, PlatformMeta];
        }),
      },
      connectTo: [{ descriptor: { context: "background" } }],
    },
  });

  await vi.waitFor(() => {
    expect((popup as any).connectionManager).toBeTruthy();
  });

  return popup;
};

describe("Nexus State Integration: Background Restart Lifecycle", () => {
  it("stops old-session listeners after restart and allows clean resubscribe on fresh handle", async () => {
    const definition = defineNexusStore<CounterState, CounterActions>({
      token: new Token(
        "state:counter:background-restart-listener-session-isolation:integration",
      ),
      state: () => ({ count: 0 }),
      actions: () => ({
        increment: async (_by: number) => 0,
      }),
    });

    let activeBackground = await createBackgroundHost(
      definition.token.id,
      createStoreService({ storeInstanceId: "bg-runtime:v1" }),
    );
    const popup = await createPopupNexus(() => activeBackground);

    const oldHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });
    const oldSnapshots: number[] = [];
    const stopOld = oldHandle.subscribe((snapshot) => {
      oldSnapshots.push(snapshot.count);
    });

    await expect(oldHandle.actions.increment(1)).resolves.toBe(1);
    await vi.waitFor(() => {
      expect(oldSnapshots).toEqual([1]);
    });

    activeBackground.closeAllConnections();
    activeBackground = await createBackgroundHost(
      definition.token.id,
      createStoreService({ storeInstanceId: "bg-runtime:v2" }),
    );

    const popupCm = (popup as any).connectionManager;
    await vi.waitFor(() => {
      expect((popupCm as any).connections.size).toBe(0);
    });
    await vi.waitFor(() => {
      expect(oldHandle.getStatus().type).toBe("disconnected");
    });

    const replacementHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });
    const replacementSnapshots: number[] = [];
    const stopReplacement = replacementHandle.subscribe((snapshot) => {
      replacementSnapshots.push(snapshot.count);
    });

    await expect(replacementHandle.actions.increment(2)).resolves.toBe(2);
    await vi.waitFor(() => {
      expect(replacementHandle.getState().count).toBe(2);
      expect(replacementSnapshots).toEqual([2]);
      expect(oldSnapshots).toEqual([1]);
    });

    await expect(oldHandle.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );

    stopOld();
    stopReplacement();
  });

  it("marks old handle disconnected and binds new handle to replacement background", async () => {
    const definition = defineNexusStore<CounterState, CounterActions>({
      token: new Token(
        "state:counter:background-restart-real-host-replacement:integration",
      ),
      state: () => ({ count: 0 }),
      actions: () => ({
        increment: async (_by: number) => 0,
      }),
    });

    let activeBackground = await createBackgroundHost(
      definition.token.id,
      createStoreService({ storeInstanceId: "bg-runtime:v1" }),
    );

    const popup = await createPopupNexus(() => activeBackground);

    const oldHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });
    await expect(oldHandle.actions.increment(1)).resolves.toBe(1);
    expect(oldHandle.getState().count).toBe(1);

    activeBackground.closeAllConnections();
    activeBackground = await createBackgroundHost(
      definition.token.id,
      createStoreService({ storeInstanceId: "bg-runtime:v2" }),
    );

    const popupCm = (popup as any).connectionManager;
    await vi.waitFor(() => {
      expect((popupCm as any).connections.size).toBe(0);
    });

    await vi.waitFor(() => {
      expect(oldHandle.getStatus().type).toBe("disconnected");
    });

    await expect(oldHandle.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );

    const replacementHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });
    await expect(replacementHandle.actions.increment(2)).resolves.toBe(2);
    expect(replacementHandle.getState().count).toBe(2);
  });

  it("quarantines late old-session snapshot after restart and keeps fresh subscriptions clean", async () => {
    const oldGate = deferred<void>();
    const oldDispatchStarted = deferred<void>();
    const oldConnectionPorts = createControlledConnectionPorts();
    let connectionAttempt = 0;

    const definition = defineNexusStore<CounterState, CounterActions>({
      token: new Token(
        "state:counter:background-restart-real-host-late-inflight:integration",
      ),
      state: () => ({ count: 0 }),
      actions: () => ({
        increment: async (_by: number) => 0,
      }),
    });

    let activeBackground = await createBackgroundHost(
      definition.token.id,
      createStoreService({
        storeInstanceId: "bg-runtime:v1",
        gate: oldGate.promise,
        onDispatchStarted: () => oldDispatchStarted.resolve(undefined),
        onDispatchBeforeCommit: (emitSnapshot) => {
          oldConnectionPorts.holdBackgroundToPopup();
          emitSnapshot();
        },
      }),
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

    const oldHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });
    const oldSnapshots: number[] = [];
    const stopOld = oldHandle.subscribe((snapshot) => {
      oldSnapshots.push(snapshot.count);
    });

    const lateOldAction = oldHandle.actions.increment(1);
    void lateOldAction.catch(() => undefined);
    await oldDispatchStarted.promise;
    await vi.waitFor(() => {
      expect(oldConnectionPorts.queuedBackgroundToPopupCount()).toBeGreaterThan(
        0,
      );
    });

    activeBackground.closeAllConnections();
    activeBackground = await createBackgroundHost(
      definition.token.id,
      createStoreService({ storeInstanceId: "bg-runtime:v2" }),
    );

    const popupCm = (popup as any).connectionManager;
    await vi.waitFor(() => {
      expect((popupCm as any).connections.size).toBe(0);
    });

    await vi.waitFor(() => {
      expect(oldHandle.getStatus().type).toBe("disconnected");
    });

    const replacementHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });
    const replacementSnapshots: number[] = [];
    const stopReplacement = replacementHandle.subscribe((snapshot) => {
      replacementSnapshots.push(snapshot.count);
    });
    await expect(replacementHandle.actions.increment(3)).resolves.toBe(3);
    await vi.waitFor(() => {
      expect(replacementSnapshots).toEqual([3]);
    });

    const lateReplacementSnapshots: number[] = [];
    const stopLateReplacement = replacementHandle.subscribe((snapshot) => {
      lateReplacementSnapshots.push(snapshot.count);
    });

    oldGate.resolve(undefined);
    oldConnectionPorts.flushBackgroundToPopup();

    await expect(lateOldAction).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(oldSnapshots).toEqual([]);
    expect(oldHandle.getState().count).toBe(0);
    expect(replacementHandle.getState().count).toBe(3);

    await expect(replacementHandle.actions.increment(2)).resolves.toBe(5);
    await vi.waitFor(() => {
      expect(replacementSnapshots).toEqual([3, 5]);
      expect(lateReplacementSnapshots).toEqual([5]);
      expect(replacementHandle.getState().count).toBe(5);
      expect(oldHandle.getState().count).toBe(0);
    });

    stopOld();
    stopReplacement();
    stopLateReplacement();
  });
});

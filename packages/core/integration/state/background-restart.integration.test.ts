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

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const createStoreService = (options: {
  storeInstanceId: string;
  gate?: Promise<void>;
  onDispatchStarted?: () => void;
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
      await options.gate;

      state = { count: state.count + args[0] };
      version += 1;

      const event: SnapshotEvent = {
        type: "snapshot",
        storeInstanceId: options.storeInstanceId,
        version,
        state,
      };

      for (const callback of subscriptions.values()) {
        callback(event);
      }

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
) => {
  const popup = new Nexus<UserMeta, PlatformMeta>();

  popup.configure({
    endpoint: {
      meta: { context: "popup" },
      implementation: {
        listen: vi.fn(),
        connect: vi.fn(async (_targetDescriptor: Partial<UserMeta>) => {
          const [popupPort, backgroundPort] = createMockPortPair();
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

const expectDisconnectedOrStale = (type: string) => {
  expect(["disconnected", "stale"]).toContain(type);
};

describe("Nexus State Integration: Background Restart Lifecycle", () => {
  it("marks old handle stale/disconnected and binds new handle to replacement background", async () => {
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
      expectDisconnectedOrStale(oldHandle.getStatus().type);
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

  it("does not revive old handle state with late in-flight action from torn-down background", async () => {
    const oldGate = deferred<void>();
    const oldDispatchStarted = deferred<void>();

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
      }),
    );

    const popup = await createPopupNexus(() => activeBackground);

    const oldHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });

    const lateOldAction = oldHandle.actions.increment(1);
    void lateOldAction.catch(() => undefined);
    await oldDispatchStarted.promise;

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
      expectDisconnectedOrStale(oldHandle.getStatus().type);
    });

    const replacementHandle = await connectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });
    await expect(replacementHandle.actions.increment(3)).resolves.toBe(3);

    oldGate.resolve(undefined);

    await expect(lateOldAction).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
    expect(oldHandle.getState().count).toBe(0);
    expect(replacementHandle.getState().count).toBe(3);
  });
});

import { describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import type { Asyncified } from "../api/types";
import { NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL } from "../types/symbols";
import { createStarNetwork } from "../utils/test-utils";
import { createNexusStore } from "./bind-store";
import { connectNexusStore, safeConnectNexusStore } from "./connect-store";
import { NexusStoreConnectError } from "./errors";
import type { NexusStoreServiceContract } from "./contract";
import { createStoreToken } from "./contract";

type State = { count: number };
type Actions = { increment(by: number): number };
const token = createStoreToken<State & Actions>("state:client");

const createHost = () =>
  createNexusStore(
    token,
    (set, get) => ({
      count: 0,
      increment(by: number) {
        set({ count: get().count + by });
        return get().count;
      },
    }),
    { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
  );

describe("State connection acquisition and handshake", () => {
  it("connects a real remote store and completes actions after its snapshot", async () => {
    const { provider, destroy } = createHost();
    const network = await createStarNetwork<
      { context: string },
      { from: string }
    >({
      center: {
        meta: { context: "host" },
        providers: { [token.id]: provider.service },
      },
      leaves: [
        {
          meta: { context: "client" },
          cmConfig: { connectTo: [{ context: "host" }] },
        },
      ],
    });
    const remote = await connectNexusStore(
      network.get("client")!.nexus,
      token,
      { target: { context: "host" } },
    );
    const order: string[] = [];
    remote.subscribe(() => order.push("snapshot"));
    await remote.actions.increment(2).then(() => order.push("action"));
    expect(order).toEqual(["snapshot", "action"]);
    expect(remote.getState()).toEqual({ count: 2 });
    remote.destroy();
    destroy();
  });

  it("returns structured connect errors and cleans a timed-out late init", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const unsubscribe = vi.fn();
    const service = {
      async subscribe(onSync: (event: unknown) => unknown) {
        await pending;
        await onSync({
          type: "init",
          storeInstanceId: "late",
          version: 0,
          state: { count: 0 },
          actions: {},
          unsubscribe,
        });
      },
    } as unknown as NexusStoreServiceContract<State & Actions>;
    const result = await safeConnectNexusStore(
      {
        safeCreate: async <T extends object>() =>
          Result.ok(service as Asyncified<T>),
      },
      token,
      { timeout: 10 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toBeInstanceOf(NexusStoreConnectError);
    resolve();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("keeps safe acquisition errors separate from protocol errors", async () => {
    const result = await safeConnectNexusStore(
      { safeCreate: async () => Result.err(new Error("no provider")) },
      token,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreConnectError);
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it.each(["throw", "reject", "result"] as const)(
    "preserves the cause of a %s acquisition failure",
    async (mode) => {
      const cause = new Error("acquisition failed");
      const result = await safeConnectNexusStore(
        {
          safeCreate: (): Promise<Result<never, Error>> => {
            if (mode === "throw") throw cause;
            if (mode === "reject") return Promise.reject(cause);
            return Promise.resolve(Result.err(cause));
          },
        },
        token,
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("E_STORE_CONNECT");
        expect(result.error.cause).toBe(cause);
      }
    },
  );

  it("reclaims init when disconnect follows its callback before the handshake returns", async () => {
    const unsubscribe = vi.fn();
    let disconnect!: () => void;
    const stopObserving = vi.fn();
    const service = {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL](notify: () => void) {
        disconnect = notify;
        return stopObserving;
      },
      async subscribe(onSync: (event: unknown) => void) {
        onSync({
          type: "init",
          storeInstanceId: "closing",
          version: 0,
          state: { count: 0 },
          actions: {},
          unsubscribe,
        });
        queueMicrotask(disconnect);
      },
    };
    const result = await safeConnectNexusStore(
      {
        safeCreate: async <T extends object>() =>
          Result.ok(service as Asyncified<T>),
      },
      token,
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("E_STORE_DISCONNECTED");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stopObserving).toHaveBeenCalledOnce();
  });
});

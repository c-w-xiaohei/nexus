import { describe, expect, it, vi } from "vitest";
import { Token } from "@/api/token";
import { defineNexusStore } from "@/state/define-store";
import {
  SERVICE_INVOKE_END,
  SERVICE_INVOKE_START,
  SERVICE_ON_DISCONNECT,
  type ServiceInvocationContext,
} from "@/service/service-invocation-hooks";
import { NexusStoreDisconnectedError } from "@/state/errors";
import { NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL } from "@/types/symbols";
import { relayNexusStore } from "./index";

interface CounterState {
  count: number;
}

const definition = defineNexusStore({
  token: new Token("relay:test-store"),
  state: (): CounterState => ({ count: 0 }),
  actions: () => ({
    increment(by: number) {
      return by;
    },
  }),
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createInvocation = (connectionId: string): ServiceInvocationContext => ({
  sourceConnectionId: connectionId,
  sourceIdentity: { context: connectionId },
  localIdentity: { context: "content-relay" },
  platform: { from: connectionId },
});

describe("relayNexusStore", () => {
  it("waits for the upstream baseline before resolving downstream subscribe", async () => {
    const gate = deferred<{
      storeInstanceId: string;
      subscriptionId: string;
      version: number;
      state: CounterState;
    }>();
    const subscribe = vi.fn(async () => gate.promise);
    const registration = relayNexusStore(definition, {
      forwardThrough: {
        create: vi.fn(async () => ({
          subscribe,
          unsubscribe: vi.fn(async () => undefined),
          dispatch: vi.fn(),
        })),
      } as any,
      forwardTarget: { descriptor: { context: "background" } },
    });

    const pending = registration.implementation.subscribe(
      vi.fn(),
      createInvocation("alpha"),
    );

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve({
      storeInstanceId: "bg-store",
      subscriptionId: "bg-sub",
      version: 3,
      state: { count: 2 },
    });

    await expect(pending).resolves.toMatchObject({
      version: 0,
      state: { count: 2 },
    });
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("returns downstream committedVersion only after projecting an upstream snapshot", async () => {
    let upstreamOnSync!: (event: unknown) => void;
    const dispatch = vi.fn(async () => ({
      type: "dispatch-result" as const,
      committedVersion: 6,
      result: 1,
    }));
    const registration = relayNexusStore(definition, {
      forwardThrough: {
        create: vi.fn(async () => ({
          subscribe: vi.fn(async (onSync: typeof upstreamOnSync) => {
            upstreamOnSync = onSync;
            return {
              storeInstanceId: "bg-store",
              subscriptionId: "bg-sub",
              version: 5,
              state: { count: 0 },
            };
          }),
          unsubscribe: vi.fn(async () => undefined),
          dispatch,
        })),
      } as any,
      forwardTarget: { descriptor: { context: "background" } },
    });
    const onSync = vi.fn();
    await registration.implementation.subscribe(
      onSync,
      createInvocation("alpha"),
    );

    const pending = registration.implementation.dispatch(
      "increment",
      [1],
      createInvocation("alpha"),
    );
    await Promise.resolve();
    expect(onSync).toHaveBeenCalledTimes(0);

    upstreamOnSync({
      type: "snapshot",
      storeInstanceId: "bg-store",
      version: 6,
      state: { count: 1 },
    });

    await expect(pending).resolves.toMatchObject({
      committedVersion: 2,
      result: 1,
    });
    expect(onSync).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "snapshot",
        version: 2,
        state: { count: 1 },
      }),
    );
  });

  it("emits a checkpoint snapshot for successful no-op upstream commits", async () => {
    const registration = relayNexusStore(definition, {
      forwardThrough: {
        create: vi.fn(async () => ({
          subscribe: vi.fn(async () => ({
            storeInstanceId: "bg-store",
            subscriptionId: "bg-sub",
            version: 5,
            state: { count: 2 },
          })),
          unsubscribe: vi.fn(async () => undefined),
          dispatch: vi.fn(async () => ({
            type: "dispatch-result" as const,
            committedVersion: 5,
            result: 0,
          })),
        })),
      } as any,
      forwardTarget: { descriptor: { context: "background" } },
    });
    const onSync = vi.fn();
    await registration.implementation.subscribe(
      onSync,
      createInvocation("alpha"),
    );

    await expect(
      registration.implementation.dispatch(
        "increment",
        [0],
        createInvocation("alpha"),
      ),
    ).resolves.toMatchObject({ committedVersion: 1, result: 0 });

    expect(onSync).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "snapshot",
        version: 1,
        state: { count: 2 },
      }),
    );
  });

  it("checks downstream dispatch policy using the trusted invocation context", async () => {
    const canDispatch = vi.fn(async () => false);
    const dispatch = vi.fn();
    const registration = relayNexusStore(definition, {
      forwardThrough: {
        create: vi.fn(async () => ({
          subscribe: vi.fn(async () => ({
            storeInstanceId: "bg-store",
            subscriptionId: "bg-sub",
            version: 1,
            state: { count: 0 },
          })),
          unsubscribe: vi.fn(async () => undefined),
          dispatch,
        })),
      } as any,
      forwardTarget: { descriptor: { context: "background" } },
      policy: { canDispatch },
    });

    await registration.implementation.subscribe(
      vi.fn(),
      createInvocation("alpha"),
    );
    await expect(
      registration.implementation.dispatch(
        "increment",
        [1],
        createInvocation("alpha"),
      ),
    ).rejects.toMatchObject({ code: "E_RELAY_POLICY_DENIED" });
    expect(canDispatch).toHaveBeenCalledWith({
      origin: { context: "alpha" },
      relay: { context: "content-relay" },
      platform: { from: "alpha" },
      tokenId: definition.token.id,
      action: "increment",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("terminalizes downstream subscribers and pending dispatch on upstream disconnect", async () => {
    let disconnectCallback!: () => void;
    const dispatchGate = deferred<{
      type: "dispatch-result";
      committedVersion: number;
      result: number;
    }>();
    const registration = relayNexusStore(definition, {
      forwardThrough: {
        create: vi.fn(async () => ({
          subscribe: Object.assign(
            vi.fn(async () => ({
              storeInstanceId: "bg-store",
              subscriptionId: "bg-sub",
              version: 1,
              state: { count: 0 },
            })),
            {
              [Symbol.for("unused")]: true,
            },
          ),
          unsubscribe: vi.fn(async () => undefined),
          dispatch: vi.fn(async () => dispatchGate.promise),
          [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (cb: () => void) => {
            disconnectCallback = cb;
            return () => undefined;
          },
        })),
      } as any,
      forwardTarget: { descriptor: { context: "background" } },
    });
    const onSync = vi.fn();
    await registration.implementation.subscribe(
      onSync,
      createInvocation("alpha"),
    );

    const pending = registration.implementation.dispatch(
      "increment",
      [1],
      createInvocation("alpha"),
    );
    disconnectCallback();
    dispatchGate.resolve({
      type: "dispatch-result",
      committedVersion: 2,
      result: 1,
    });

    await expect(pending).rejects.toBeInstanceOf(NexusStoreDisconnectedError);
    expect(onSync).toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal" }),
    );
  });

  it("cleans subscriptions only for the disconnected owner", async () => {
    let upstreamOnSync!: (event: unknown) => void;
    const registration = relayNexusStore(definition, {
      forwardThrough: {
        create: vi.fn(async () => ({
          subscribe: vi.fn(async (onSync: typeof upstreamOnSync) => {
            upstreamOnSync = onSync;
            return {
              storeInstanceId: "bg-store",
              subscriptionId: "bg-sub",
              version: 1,
              state: { count: 0 },
            };
          }),
          unsubscribe: vi.fn(async () => undefined),
          dispatch: vi.fn(),
        })),
      } as any,
      forwardTarget: { descriptor: { context: "background" } },
    });
    const onAlpha = vi.fn();
    const onBeta = vi.fn();
    await registration.implementation.subscribe(
      onAlpha,
      createInvocation("alpha"),
    );
    await registration.implementation.subscribe(
      onBeta,
      createInvocation("beta"),
    );

    (registration.implementation as any)[SERVICE_ON_DISCONNECT]("alpha");
    upstreamOnSync({
      type: "snapshot",
      storeInstanceId: "bg-store",
      version: 2,
      state: { count: 1 },
    });

    expect(onAlpha).not.toHaveBeenCalled();
    expect(onBeta).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "snapshot",
        version: 1,
        state: { count: 1 },
      }),
    );
  });
});

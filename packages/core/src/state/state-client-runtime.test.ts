/**
 * These tests exercise the state client runtime and connect APIs directly.
 * They stay under `src/state` because they validate core runtime semantics,
 * handshake behavior, and error classification without going through the
 * higher-level package integration scenarios in `packages/core/integration`.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { errAsync } from "neverthrow";
import { z } from "zod";
import { Token } from "../api/token";
import { createL3Endpoints, createStarNetwork } from "../utils/test-utils";
import { defineNexusStore } from "./define-store";
import {
  NexusStoreConnectError,
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
  normalizeNexusStoreError,
} from "./errors";
import { provideNexusStore } from "./provide-store";
import type { NexusStoreServiceContract } from "./types";
import {
  connectNexusStore,
  safeConnectNexusStore,
  safeInvokeStoreAction,
} from "./connect-store";
import { RemoteStoreEntity } from "./client/remote-store";
import {
  NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL,
  NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL,
} from "../types/symbols";

const createCounterDefinition = () =>
  defineNexusStore({
    token: new Token("state:counter:host-runtime"),
    state: () => ({ count: 0 }),
    actions: ({ getState, setState }) => ({
      increment(by: number) {
        setState({ count: getState().count + by });
        return getState().count;
      },
      explode() {
        throw new Error("boom");
      },
      mutateThenExplode() {
        setState({ count: 999 });
        throw new Error("boom-after-mutate");
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

describe("state client runtime and connect APIs", () => {
  it("safeConnectNexusStore maps disconnect-hook getter errors with normalization branches", async () => {
    const definition = defineNexusStore({
      token: new Token("state:counter:disconnect-hook-getter-errors"),
      state: () => ({ count: 0 }),
      actions: () => ({ noop: () => 0 }),
    });

    const baseline = {
      storeInstanceId: "store-disconnect-hook-getter-errors",
      subscriptionId: "sub-disconnect-hook-getter-errors",
      version: 0,
      state: { count: 0 },
    };

    const actionGetterService = {
      subscribe: vi.fn(async () => baseline),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
      get [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]() {
        throw new NexusStoreActionError("disconnect-getter-action-error");
      },
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const actionGetterResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof actionGetterService) => any) =>
                next(actionGetterService),
            }),
          }) as any,
      } as any,
      definition,
      {},
    );

    expect(actionGetterResult.isErr()).toBe(true);
    if (actionGetterResult.isErr()) {
      expect(actionGetterResult.error).toBeInstanceOf(NexusStoreConnectError);
      expect(actionGetterResult.error.cause).toBeInstanceOf(
        NexusStoreActionError,
      );
    }

    const disconnectLike = Object.assign(new Error("conn closed in getter"), {
      code: "E_CONN_CLOSED",
    });
    const disconnectedGetterService = {
      subscribe: vi.fn(async () => baseline),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
      get [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]() {
        throw disconnectLike;
      },
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const disconnectedGetterResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (
                next: (value: typeof disconnectedGetterService) => any,
              ) => next(disconnectedGetterService),
            }),
          }) as any,
      } as any,
      definition,
      {},
    );

    expect(disconnectedGetterResult.isErr()).toBe(true);
    if (disconnectedGetterResult.isErr()) {
      expect(disconnectedGetterResult.error).toBeInstanceOf(
        NexusStoreDisconnectedError,
      );
    }
  });

  it("safeConnectNexusStore handles disconnect-hook subscribe branches", async () => {
    const definition = defineNexusStore({
      token: new Token("state:counter:disconnect-hook-subscribe-branches"),
      state: () => ({ count: 0 }),
      actions: () => ({ noop: () => 0 }),
    });

    const baseline = {
      storeInstanceId: "store-disconnect-hook-subscribe-branches",
      subscriptionId: "sub-disconnect-hook-subscribe-branches",
      version: 0,
      state: { count: 0 },
    };

    const throwingHookService = {
      subscribe: vi.fn(async () => baseline),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: () => {
        throw new Error("disconnect-subscribe-throw");
      },
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const throwingHookResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof throwingHookService) => any) =>
                next(throwingHookService),
            }),
          }) as any,
      } as any,
      definition,
      {},
    );

    expect(throwingHookResult.isErr()).toBe(true);
    if (throwingHookResult.isErr()) {
      expect(throwingHookResult.error).toBeInstanceOf(NexusStoreProtocolError);
      expect(throwingHookResult.error.message).toBe(
        "disconnect-subscribe-throw",
      );
    }

    const noopHookService = {
      subscribe: vi.fn(async () => baseline),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: () => 123,
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const noopHookResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof noopHookService) => any) =>
                next(noopHookService),
            }),
          }) as any,
      } as any,
      definition,
      {},
    );

    expect(noopHookResult.isOk()).toBe(true);
    if (noopHookResult.isOk()) {
      noopHookResult.value.destroy();
    }
  });

  it("safeConnectNexusStore timeout skips late unsubscribe for non-string subscription id", async () => {
    const baselineGate = deferred<{
      storeInstanceId: string;
      subscriptionId: number;
      version: number;
      state: { count: number };
    }>();
    const unsubscribe = vi.fn(async () => {});
    const service = {
      subscribe: vi.fn(async () => baselineGate.promise),
      unsubscribe,
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof service) => any) => next(service),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:timeout-non-string-subscription-id"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { timeout: 10 },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreConnectError);
      expect(result.error.message).toMatch(/timed out/i);
    }

    baselineGate.resolve({
      storeInstanceId: "store-timeout-non-string-subscription-id",
      subscriptionId: 123,
      version: 0,
      state: { count: 0 },
    });

    await vi.waitFor(() => {
      expect(unsubscribe).not.toHaveBeenCalled();
    });
  });

  it("connectNexusStore wraps rejected create errors from create-only nexus", async () => {
    const definition = defineNexusStore({
      token: new Token("state:counter:connect-create-rejects"),
      state: () => ({ count: 0 }),
      actions: () => ({ noop: () => 0 }),
    });

    await expect(
      connectNexusStore(
        {
          create: async () => {
            throw new Error("create-error-instance");
          },
        } as any,
        definition,
        {},
      ),
    ).rejects.toMatchObject({
      name: "NexusStoreConnectError",
      cause: expect.objectContaining({ message: "create-error-instance" }),
    });

    await expect(
      connectNexusStore(
        {
          create: async () => {
            throw "create-error-non-instance";
          },
        } as any,
        definition,
        {},
      ),
    ).rejects.toMatchObject({
      name: "NexusStoreConnectError",
      cause: expect.objectContaining({ message: "create-error-non-instance" }),
    });
  });

  it("safeInvokeStoreAction preserves known store error types", async () => {
    const disconnected = new NexusStoreDisconnectedError(
      "already disconnected",
    );
    const protocol = new NexusStoreProtocolError("protocol mismatch");
    const action = new NexusStoreActionError("already wrapped action error");

    const disconnectedResult = await safeInvokeStoreAction(
      {
        actions: {
          run: async () => {
            throw disconnected;
          },
        },
      } as any,
      "run",
      [],
    );
    expect(disconnectedResult.isErr()).toBe(true);
    if (disconnectedResult.isErr()) {
      expect(disconnectedResult.error).toBe(disconnected);
    }

    const protocolResult = await safeInvokeStoreAction(
      {
        actions: {
          run: async () => {
            throw protocol;
          },
        },
      } as any,
      "run",
      [],
    );
    expect(protocolResult.isErr()).toBe(true);
    if (protocolResult.isErr()) {
      expect(protocolResult.error).toBe(protocol);
    }

    const actionResult = await safeInvokeStoreAction(
      {
        actions: {
          run: async () => {
            throw action;
          },
        },
      } as any,
      "run",
      [],
    );
    expect(actionResult.isErr()).toBe(true);
    if (actionResult.isErr()) {
      expect(actionResult.error).toBe(action);
    }
  });

  it("safeConnectNexusStore rejects invalid connect options refine path", async () => {
    const definition = defineNexusStore({
      token: new Token("state:counter:connect-invalid-options"),
      state: () => ({ count: 0 }),
      actions: () => ({
        increment: (by: number) => by,
      }),
    });

    const result = await safeConnectNexusStore(
      {
        safeCreate: vi.fn(),
      } as any,
      definition,
      {
        target: {} as any,
      },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreConnectError);
      expect(result.error.message).toBe("Invalid connect store options.");
      expect(result.error.cause).toBeDefined();
    }
  });

  it("safeConnectNexusStore adapts safeCreate failure to connect error", async () => {
    const definition = defineNexusStore({
      token: new Token("state:counter:safe-create-failure"),
      state: () => ({ count: 0 }),
      actions: () => ({ noop: () => 0 }),
    });

    const createFailure = new Error("safeCreate failed");
    const result = await safeConnectNexusStore(
      {
        safeCreate: () => errAsync(createFailure),
      } as any,
      definition,
      {},
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreConnectError);
      expect(result.error.message).toBe("Failed to create store proxy.");
      expect(result.error.cause).toBe(createFailure);
    }
  });

  it("safeConnectNexusStore captures synchronous definition.state throw", async () => {
    const stateError = new Error("state-init-failed");
    const definition = defineNexusStore({
      token: new Token("state:counter:state-throw"),
      state: () => {
        throw stateError;
      },
      actions: () => ({ noop: () => 0 }),
    });

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (
                next: (value: NexusStoreServiceContract<any, any>) => any,
              ) =>
                next({
                  subscribe: vi.fn(async () => ({
                    storeInstanceId: "store-state-throw",
                    subscriptionId: "sub-state-throw",
                    version: 0,
                    state: { count: 0 },
                  })),
                  unsubscribe: vi.fn(async () => {}),
                  dispatch: vi.fn(async () => ({
                    type: "dispatch-result",
                    committedVersion: 1,
                    result: 0,
                  })),
                } as NexusStoreServiceContract<any, any>),
            }),
          }) as any,
      } as any,
      definition,
      {},
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreProtocolError);
      expect(result.error.message).toBe("state-init-failed");
      expect(result.error.cause).toBe(stateError);
    }
  });

  it("connectNexusStore connects through ordinary Nexus service proxy", async () => {
    const counterStore = defineNexusStore({
      token: new Token("state:counter:connect-api"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
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

    expect(remote.getStatus().type).toBe("ready");
    expect(remote.getState().count).toBe(0);

    await remote.actions.increment(2);
    expect(remote.getState().count).toBe(2);

    remote.destroy();
  });

  it("keeps still-matching dynamic-target handle ready on benign identity updates", async () => {
    type Meta = {
      context: "background" | "content-script";
      isActive?: boolean;
      issueId?: string;
      url?: string;
    };

    const definition = defineNexusStore({
      token: new Token("state:counter:still-matching-dynamic-target"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
    });

    const registration = provideNexusStore(definition);
    const network = await createStarNetwork<Meta, { from: string }>({
      center: {
        meta: { context: "background" },
      },
      leaves: [
        {
          meta: {
            context: "content-script",
            isActive: true,
            issueId: "CS-ACTIVE",
            url: "github.com/issue/a",
          },
          services: {
            [definition.token.id]: registration.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const backgroundNexus = network.get("background")!.nexus;
    const csNexus = network.get("content-script:CS-ACTIVE")!.nexus;

    const remote = await connectNexusStore(backgroundNexus, definition, {
      target: {
        descriptor: { context: "content-script" },
        matcher: (id: Meta) =>
          id.context === "content-script" && id.isActive === true,
      },
    });

    await remote.actions.increment(1);
    expect(remote.getState().count).toBe(1);

    await csNexus.updateIdentity({ url: "github.com/issue/a?updated=1" });
    await new Promise((r) => setTimeout(r, 30));

    expect(remote.getStatus().type).toBe("ready");
    await expect(remote.actions.increment(2)).resolves.toBe(3);
    expect(remote.getState().count).toBe(3);

    remote.destroy();
  });

  it("marks dynamic-target handle stale when target semantics stop matching", async () => {
    type Meta = {
      context: "background" | "content-script";
      isActive?: boolean;
      issueId?: string;
      url?: string;
    };

    const definition = defineNexusStore({
      token: new Token("state:counter:dynamic-target-movement"),
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          setState({ count: getState().count + by });
          return getState().count;
        },
      }),
    });

    const registration1 = provideNexusStore(definition);
    const registration2 = provideNexusStore(definition);

    const network = await createStarNetwork<Meta, { from: string }>({
      center: {
        meta: { context: "background" },
      },
      leaves: [
        {
          meta: {
            context: "content-script",
            isActive: true,
            issueId: "CS-1",
            url: "github.com/issue/1",
          },
          services: {
            [definition.token.id]: registration1.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
        {
          meta: {
            context: "content-script",
            issueId: "CS-2",
            url: "github.com/issue/2",
          },
          services: {
            [definition.token.id]: registration2.implementation,
          },
          cmConfig: { connectTo: [{ descriptor: { context: "background" } }] },
        },
      ],
    });

    const backgroundNexus = network.get("background")!.nexus;
    const cs1Nexus = network.get("content-script:CS-1")!.nexus;

    const remote = await connectNexusStore(backgroundNexus, definition, {
      target: {
        descriptor: { context: "content-script" },
        matcher: (id: Meta) =>
          id.context === "content-script" && id.isActive === true,
      },
    });

    await remote.actions.increment(1);
    expect(remote.getState().count).toBe(1);

    await cs1Nexus.updateIdentity({ isActive: false });

    await vi.waitFor(() => {
      expect(remote.getStatus().type).toBe("stale");
    });
    await expect(remote.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });

  it("safeConnectNexusStore returns ResultAsync", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);
    const network = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        services: {
          [definition.token.id]: registration.implementation,
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
    const result = await safeConnectNexusStore(popup, definition, {
      target: { descriptor: { context: "background" } },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      result.value.destroy();
    }
  });

  it("connect path rejects non-object state payload without explicit validation schema", async () => {
    const remoteResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (
                next: (value: NexusStoreServiceContract<any, any>) => any,
              ) =>
                next({
                  subscribe: vi.fn(async () => ({
                    storeInstanceId: "store-invalid-state-shape",
                    subscriptionId: "sub-invalid-state-shape",
                    version: 0,
                    state: 42,
                  })),
                  unsubscribe: vi.fn(async () => {}),
                  dispatch: vi.fn(async () => ({
                    type: "dispatch-result",
                    committedVersion: 1,
                    result: 0,
                  })),
                } as NexusStoreServiceContract<any, any>),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:invalid-state-shape"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      {},
    );

    expect(remoteResult.isErr()).toBe(true);
    if (remoteResult.isErr()) {
      expect(remoteResult.error).toBeInstanceOf(NexusStoreProtocolError);
      expect(remoteResult.error.message).toMatch(/state payload/i);
    }
  });

  it("connect path validates state and action result payloads when schemas are provided", async () => {
    let onSync!: (event: unknown) => void;
    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-validated-runtime",
          subscriptionId: "sub-validated-runtime",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: "invalid-result",
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:validated-runtime"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
        validation: {
          state: z.object({ count: z.number().int().nonnegative() }),
          actionResults: {
            increment: z.number().int().nonnegative(),
          },
        },
      }),
      {},
    );

    await expect(remote.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );

    onSync({
      type: "snapshot",
      storeInstanceId: "store-validated-runtime",
      version: 2,
      state: { count: -1 },
    });

    expect(remote.getStatus().type).toBe("disconnected");
    await expect(remote.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );
  });

  it("handles callback-before-subscribe-return ordering without rollback", async () => {
    const events: Array<(event: any) => void> = [];
    const service = {
      subscribe: vi.fn(async (onSync: (event: any) => void) => {
        events.push(onSync);
        onSync({
          type: "snapshot",
          storeInstanceId: "store-a",
          version: 1,
          state: { count: 1 },
        });

        return {
          storeInstanceId: "store-a",
          subscriptionId: "sub-1",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 1,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:ordering"),
        state: () => ({ count: 0 }),
        actions: () => ({
          increment(by: number) {
            return by;
          },
        }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(remote.getState()).toEqual({ count: 1 });
    expect((remote.getStatus() as { version?: number }).version).toBe(1);
  });

  it("ignores duplicate versions, errors on smaller version, and invalidates on instance mismatch", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-a",
          subscriptionId: "sub-2",
          version: 1,
          state: { count: 1 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 2,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:version-guards"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    onSync({
      type: "snapshot",
      storeInstanceId: "store-a",
      version: 1,
      state: { count: 999 },
    });
    expect(remote.getState().count).toBe(1);

    onSync({
      type: "snapshot",
      storeInstanceId: "store-a",
      version: 0,
      state: { count: 0 },
    });
    expect(remote.getStatus().type).toBe("disconnected");
    expect((remote.getStatus() as { cause?: unknown }).cause).toBeInstanceOf(
      NexusStoreProtocolError,
    );
    const disconnectedSnapshot = remote.getState();
    onSync({
      type: "snapshot",
      storeInstanceId: "store-a",
      version: 5,
      state: { count: 5 },
    });
    expect(remote.getStatus().type).toBe("disconnected");
    expect(remote.getState()).toEqual(disconnectedSnapshot);
    await expect(remote.actions.noop()).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );

    const remote2 = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:instance-guard"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    onSync({
      type: "snapshot",
      storeInstanceId: "store-b",
      version: 2,
      state: { count: 2 },
    });
    expect(remote2.getStatus().type).toBe("stale");
    const staleSnapshot = remote2.getState();
    onSync({
      type: "snapshot",
      storeInstanceId: "store-a",
      version: 6,
      state: { count: 6 },
    });
    expect(remote2.getStatus().type).toBe("stale");
    expect(remote2.getState()).toEqual(staleSnapshot);
    await expect(remote2.actions.noop()).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
    expect(service.unsubscribe).toHaveBeenCalledWith("sub-2");
  });

  it("tracks lifecycle and supports idempotent unsubscribe/destroy with listener throw isolation", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-life",
          subscriptionId: "sub-life",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:lifecycle"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(remote.getStatus().type).toBe("ready");
    const throwing = vi.fn(() => {
      throw new Error("listener boom");
    });
    const stable = vi.fn();
    const unsubscribeThrowing = remote.subscribe(throwing);
    const unsubscribeStable = remote.subscribe(stable);

    onSync({
      type: "snapshot",
      storeInstanceId: "store-life",
      version: 1,
      state: { count: 1 },
    });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(stable).toHaveBeenCalledTimes(1);

    unsubscribeThrowing();
    unsubscribeThrowing();
    unsubscribeStable();
    unsubscribeStable();

    remote.destroy();
    remote.destroy();
    expect(remote.getStatus().type).toBe("destroyed");
  });

  it("terminal stale/disconnected transitions stop serving future snapshots without explicit mirror destroy", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-terminal-state",
          subscriptionId: "sub-terminal-state",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 1,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:terminal-state-no-mirror-destroy"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    const observed: number[] = [];
    remote.subscribe((snapshot) => {
      observed.push(snapshot.count);
    });

    onSync({
      type: "snapshot",
      storeInstanceId: "store-terminal-state",
      version: 1,
      state: { count: 1 },
    });
    expect(observed).toEqual([1]);
    expect(remote.getState()).toEqual({ count: 1 });

    (
      remote as RemoteStoreEntity<{ count: number }, { increment(): number }>
    ).onTransportDisconnect("forced disconnect");
    expect(remote.getStatus().type).toBe("disconnected");

    onSync({
      type: "snapshot",
      storeInstanceId: "store-terminal-state",
      version: 2,
      state: { count: 2 },
    });

    expect(observed).toEqual([1]);
    expect(remote.getState()).toEqual({ count: 1 });
  });

  it("await remote actions resolves only after mirror observes committed version", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;
    let version = 0;
    const callOrder: string[] = [];

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-action-order",
          subscriptionId: "sub-action-order",
          version,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        version += 1;
        setTimeout(() => {
          onSync({
            type: "snapshot",
            storeInstanceId: "store-action-order",
            version,
            state: { count: version },
          });
        }, 0);
        return {
          type: "dispatch-result",
          committedVersion: version,
          result: version,
        };
      }),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:action-order"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    remote.subscribe(() => {
      callOrder.push("listener");
    });

    const actionPromise = remote.actions.increment().then(() => {
      callOrder.push("action-resolved");
    });
    expect(remote.getState().count).toBe(0);

    await actionPromise;
    expect(remote.getState().count).toBe(1);
    expect(callOrder).toEqual(["listener", "action-resolved"]);
  });

  it("concurrent actions resolve only after their own committed versions", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;
    let dispatchCount = 0;
    const completionOrder: string[] = [];

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-concurrent",
          subscriptionId: "sub-concurrent",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          return {
            type: "dispatch-result",
            committedVersion: 2,
            result: "first",
          };
        }

        return {
          type: "dispatch-result",
          committedVersion: 1,
          result: "second",
        };
      }),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { first(): string; second(): string }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:concurrent-actions"),
        state: () => ({ count: 0 }),
        actions: () => ({
          first: () => "first",
          second: () => "second",
        }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    const first = remote.actions
      .first()
      .then(() => completionOrder.push("first"));
    const second = remote.actions
      .second()
      .then(() => completionOrder.push("second"));

    onSync({
      type: "snapshot",
      storeInstanceId: "store-concurrent",
      version: 1,
      state: { count: 1 },
    });

    await vi.waitFor(() => {
      expect(completionOrder).toEqual(["second"]);
    });

    onSync({
      type: "snapshot",
      storeInstanceId: "store-concurrent",
      version: 2,
      state: { count: 2 },
    });

    await vi.waitFor(() => {
      expect(completionOrder).toEqual(["second", "first"]);
    });

    await Promise.all([first, second]);
  });

  it("in-flight disconnect returns explicit unknown-commit disconnect error", async () => {
    const gate = deferred<void>();
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-disconnect-race",
          subscriptionId: "sub-disconnect-race",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        await gate.promise;
        throw new NexusStoreDisconnectedError("transport disconnected");
      }),
    } satisfies NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:disconnect-race"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    const pending = remote.actions.increment();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({
      name: "NexusStoreDisconnectedError",
      message: expect.stringMatching(/unknown commit/i),
    });
    expect(remote.getStatus().type).toBe("disconnected");
    await expect(remote.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });

  it("times out action commit wait when committedVersion snapshot never arrives", async () => {
    const service = {
      subscribe: vi.fn(async (_callback: (event: unknown) => void) => {
        return {
          storeInstanceId: "store-missing-commit-snapshot",
          subscriptionId: "sub-missing-commit-snapshot",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 2,
        result: 2,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remoteEntity = new RemoteStoreEntity<
      { count: number },
      { increment(): number }
    >(service, { count: 0 }, undefined, { actionCommitTimeoutMs: 30 });

    const baseline = await service.subscribe((event) => {
      remoteEntity.onSync(event);
    });
    remoteEntity.completeHandshake(baseline);

    await expect(remoteEntity.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );
    expect(remoteEntity.getStatus().type).toBe("disconnected");

    await expect(remoteEntity.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );
  });

  it("safeConnectNexusStore subscribes and reacts to target-stale hook", async () => {
    const cleanupDisconnect = vi.fn();
    const cleanupTargetStale = vi.fn();
    let emitTargetStale!: () => void;

    const service = {
      subscribe: vi.fn(async () => ({
        storeInstanceId: "store-target-stale-hook",
        subscriptionId: "sub-target-stale-hook",
        version: 0,
        state: { count: 0 },
      })),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 1,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: vi.fn(
        () => cleanupDisconnect,
      ),
      [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]: vi.fn(
        (callback: () => void) => {
          emitTargetStale = callback;
          return cleanupTargetStale;
        },
      ),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    > & {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => () => void;
      [NEXUS_SUBSCRIBE_CONNECTION_TARGET_STALE_SYMBOL]: (
        callback: () => void,
      ) => () => void;
    };

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof service) => any) => next(service),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:target-stale-hook"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      {},
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    const remote = result.value;
    expect(remote.getStatus().type).toBe("ready");

    expect(emitTargetStale).toBeTypeOf("function");
    emitTargetStale();

    expect(remote.getStatus().type).toBe("stale");
    await expect(remote.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );

    expect(cleanupDisconnect).toHaveBeenCalledTimes(1);
    expect(cleanupTargetStale).toHaveBeenCalledTimes(1);
  });

  it("safeInvokeStoreAction preserves typed args/result and safe error union", async () => {
    type CounterState = { count: number };
    type CounterActions = {
      increment(by: number): Promise<{ count: number }>;
    };

    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: CounterState;
    }) => void;
    let version = 0;
    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-safe-action",
          subscriptionId: "sub-safe-action",
          version,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        version += 1;
        onSync({
          type: "snapshot",
          storeInstanceId: "store-safe-action",
          version,
          state: { count: version },
        });
        return {
          type: "dispatch-result",
          committedVersion: version,
          result: { count: version },
        };
      }),
    } as unknown as NexusStoreServiceContract<CounterState, CounterActions>;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore<CounterState, CounterActions>({
        token: new Token("state:counter:safe-action"),
        state: () => ({ count: 0 }),
        actions: () => ({
          increment: async () => ({ count: 0 }),
        }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    const result = await safeInvokeStoreAction(remote, "increment", [1]);
    expect(result.isOk()).toBe(true);

    expectTypeOf(safeInvokeStoreAction(remote, "increment", [1])).toMatchTypeOf<
      PromiseLike<
        import("neverthrow").Result<
          { count: number },
          | NexusStoreActionError
          | NexusStoreDisconnectedError
          | NexusStoreProtocolError
        >
      >
    >();
  });

  it("safeInvokeStoreAction wraps unknown action errors as NexusStoreActionError", async () => {
    const remoteStore = {
      actions: {
        increment: vi.fn(async () => {
          throw "raw-error";
        }),
      },
    } as unknown as {
      actions: {
        increment(by: number): Promise<number>;
      };
    };

    const result = await safeInvokeStoreAction(
      remoteStore as any,
      "increment",
      [1],
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreActionError);
      expect(result.error.message).toBe("Store action failed.");
      expect(result.error.cause).toBe("raw-error");
    }
  });

  it("safeInvokeStoreAction captures throwy action property access", async () => {
    const accessError = new Error("action-getter-throw");
    const remoteStore = {
      get actions() {
        throw accessError;
      },
    } as unknown as {
      actions: {
        increment(by: number): Promise<number>;
      };
    };

    const result = await safeInvokeStoreAction(
      remoteStore as any,
      "increment",
      [1],
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreActionError);
      expect(result.error.message).toBe("Store action failed.");
      expect(result.error.cause).toBe(accessError);
    }
  });

  it("safeInvokeStoreAction captures throwy action getter invocation", async () => {
    const invokeError = new Error("action-invoke-throw");
    const actions = {} as Record<string, unknown>;
    Object.defineProperty(actions, "increment", {
      get() {
        throw invokeError;
      },
    });

    const remoteStore = {
      actions,
    } as unknown as {
      actions: {
        increment(by: number): Promise<number>;
      };
    };

    const result = await safeInvokeStoreAction(
      remoteStore as any,
      "increment",
      [1],
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreActionError);
      expect(result.error.message).toBe("Store action failed.");
      expect(result.error.cause).toBe(invokeError);
    }
  });

  it("remote action path captures sync dispatch throw and untrusted parse throws", async () => {
    const dispatchThrow = new Error("dispatch-sync-throw");
    const parseThrow = new Error("dispatch-parse-throw");
    let dispatchCalls = 0;

    const service = {
      subscribe: vi.fn(async () => {
        return {
          storeInstanceId: "store-throwy-dispatch",
          subscriptionId: "sub-throwy-dispatch",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(() => {
        dispatchCalls += 1;
        if (dispatchCalls === 1) {
          throw dispatchThrow;
        }

        return Promise.resolve({
          type: "dispatch-result",
          get committedVersion() {
            throw parseThrow;
          },
          result: 1,
        });
      }),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:throwy-dispatch-capture"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    await expect(remote.actions.increment()).rejects.toMatchObject({
      name: "NexusStoreActionError",
      cause: dispatchThrow,
    } satisfies Partial<NexusStoreActionError>);

    await expect(remote.actions.increment()).rejects.toMatchObject({
      name: "NexusStoreProtocolError",
      cause: parseThrow,
    } satisfies Partial<NexusStoreProtocolError>);
  });

  it("keeps business errors with disconnect-like words as action errors", async () => {
    const service = {
      subscribe: vi.fn(async () => ({
        storeInstanceId: "store-business-disconnect-words",
        subscriptionId: "sub-business-disconnect-words",
        version: 0,
        state: { count: 0 },
      })),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        throw new Error(
          "business validation failed: connection quota exceeded",
        );
      }),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:business-disconnect-words"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    await expect(remote.actions.increment()).rejects.toMatchObject({
      name: "NexusStoreActionError",
      cause: expect.objectContaining({
        message: "business validation failed: connection quota exceeded",
      }),
    } satisfies Partial<NexusStoreActionError>);
    expect(remote.getStatus().type).toBe("ready");
  });

  it("does not terminalize handle for business errors that mention disconnect", async () => {
    const service = {
      subscribe: vi.fn(async () => ({
        storeInstanceId: "store-business-disconnect-wording",
        subscriptionId: "sub-business-disconnect-wording",
        version: 0,
        state: { count: 0 },
      })),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        throw new Error(
          "business rule rejected: disconnect from billing connection policy",
        );
      }),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:business-disconnect-wording"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    await expect(remote.actions.increment()).rejects.toMatchObject({
      name: "NexusStoreActionError",
      cause: expect.objectContaining({
        message:
          "business rule rejected: disconnect from billing connection policy",
      }),
    } satisfies Partial<NexusStoreActionError>);
    expect(remote.getStatus().type).toBe("ready");
  });

  it("keeps structured disconnect classification for code-tagged transport errors", async () => {
    const service = {
      subscribe: vi.fn(async () => ({
        storeInstanceId: "store-coded-disconnect",
        subscriptionId: "sub-coded-disconnect",
        version: 0,
        state: { count: 0 },
      })),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        throw Object.assign(new Error("transport channel dropped"), {
          code: "E_STORE_DISCONNECTED",
        });
      }),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:coded-disconnect"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    await expect(remote.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
    expect(remote.getStatus().type).toBe("disconnected");
  });

  it("safeConnectNexusStore preserves handshake failure classification and cause", async () => {
    const disconnectedCause = new NexusStoreDisconnectedError(
      "socket dropped during subscribe",
    );

    const brokenService = {
      subscribe: vi.fn(async () => {
        throw disconnectedCause;
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const disconnectedResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof brokenService) => any) =>
                next(brokenService),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:handshake-disconnected"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(disconnectedResult.isErr()).toBe(true);
    if (disconnectedResult.isErr()) {
      expect(disconnectedResult.error).toBeInstanceOf(
        NexusStoreDisconnectedError,
      );
      expect(disconnectedResult.error).toBe(disconnectedCause);
    }

    const malformedService = {
      subscribe: vi.fn(async () => ({
        storeInstanceId: "store-bad-baseline",
        subscriptionId: "sub-bad-baseline",
        version: "nope",
        state: { count: 0 },
      })),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const malformedResult = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof malformedService) => any) =>
                next(malformedService),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:handshake-malformed"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(malformedResult.isErr()).toBe(true);
    if (malformedResult.isErr()) {
      expect(malformedResult.error).toBeInstanceOf(NexusStoreProtocolError);
      expect(malformedResult.error.cause).toBeDefined();
    }
  });

  it("safeConnectNexusStore classifies stale-during-handshake as disconnected", async () => {
    const staleDuringHandshakeService = {
      subscribe: vi.fn(async (onSync: (event: unknown) => void) => {
        onSync({
          type: "snapshot",
          storeInstanceId: "store-stale-event",
          version: 1,
          state: { count: 1 },
        });

        return {
          storeInstanceId: "store-baseline",
          subscriptionId: "sub-stale-during-handshake",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (
                next: (value: typeof staleDuringHandshakeService) => any,
              ) => next(staleDuringHandshakeService),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:stale-during-handshake"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreDisconnectedError);
      expect(result.error.message).toMatch(/stale/i);
    }
  });

  it("safeConnectNexusStore rejects terminal envelope before baseline", async () => {
    const terminalBeforeBaselineService = {
      subscribe: vi.fn(async (onSync: (event: unknown) => void) => {
        onSync({
          type: "terminal",
          storeInstanceId: "store-terminal-before-baseline",
          lastKnownVersion: 3,
          reason: "target-replaced",
        });

        return {
          storeInstanceId: "store-terminal-before-baseline",
          subscriptionId: "sub-terminal-before-baseline",
          version: 3,
          state: { count: 3 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 4,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (
                next: (value: typeof terminalBeforeBaselineService) => any,
              ) => next(terminalBeforeBaselineService),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:terminal-before-baseline"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreDisconnectedError);
      expect(result.error.message).toMatch(/terminal|stale|disconnected/i);
    }
  });

  it("safeConnectNexusStore ignores buffered terminal with mismatched instance before baseline", async () => {
    const service = {
      subscribe: vi.fn(async (onSync: (event: unknown) => void) => {
        onSync({
          type: "terminal",
          storeInstanceId: "store-terminal-buffered-other",
          lastKnownVersion: 3,
          reason: "target-replaced",
        });

        return {
          storeInstanceId: "store-terminal-buffered-real",
          subscriptionId: "sub-terminal-buffered-real",
          version: 3,
          state: { count: 3 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 4,
        result: 4,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof service) => any) => next(service),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:terminal-buffered-mismatch"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.getStatus()).toMatchObject({
        type: "ready",
        storeInstanceId: "store-terminal-buffered-real",
        version: 3,
      });
    }
  });

  it("safeConnectNexusStore applies matching terminal when multiple pre-baseline terminals arrive", async () => {
    const service = {
      subscribe: vi.fn(async (onSync: (event: unknown) => void) => {
        onSync({
          type: "terminal",
          storeInstanceId: "store-terminal-buffered-real",
          lastKnownVersion: 3,
          reason: "target-replaced",
        });
        onSync({
          type: "terminal",
          storeInstanceId: "store-terminal-buffered-other",
          lastKnownVersion: 7,
          reason: "target-replaced",
        });

        return {
          storeInstanceId: "store-terminal-buffered-real",
          subscriptionId: "sub-terminal-buffered-real",
          version: 3,
          state: { count: 3 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 4,
        result: 4,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof service) => any) => next(service),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:terminal-buffered-multi"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreDisconnectedError);
      expect(result.error.message).toMatch(/terminal|stale|disconnect/i);
    }
  });

  it("rejects action when terminalized even if lastKnownVersion already satisfies waiter", async () => {
    const service = {
      subscribe: vi.fn(async () => {
        return {
          storeInstanceId: "store-terminal-fastpath",
          subscriptionId: "sub-terminal-fastpath",
          version: 1,
          state: { count: 1 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 1,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      { create: async () => service } as any,
      defineNexusStore({
        token: new Token("state:counter:terminal-fastpath"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    (remote as any).onSync({
      type: "terminal",
      storeInstanceId: "store-terminal-fastpath",
      lastKnownVersion: 1,
      reason: "target-replaced",
    });

    await expect(remote.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });

  it("RemoteStoreEntity transitions terminal after baseline and rejects future actions", async () => {
    let onSync!: (event: unknown) => void;
    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-terminal-after-baseline",
          subscriptionId: "sub-terminal-after-baseline",
          version: 1,
          state: { count: 1 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 2,
        result: 2,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:terminal-after-baseline"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    onSync({
      type: "terminal",
      storeInstanceId: "store-terminal-after-baseline",
      lastKnownVersion: 1,
      reason: "target-replaced",
    });

    expect(remote.getStatus().type).toBe("stale");
    await expect(remote.actions.increment()).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });

  it("ignores terminal envelopes with mismatched store instance id", async () => {
    let onSync!: (event: unknown) => void;
    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-terminal-instance-guard",
          subscriptionId: "sub-terminal-instance-guard",
          version: 1,
          state: { count: 1 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 2,
        result: 2,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:terminal-instance-guard"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    onSync({
      type: "terminal",
      storeInstanceId: "store-other-instance",
      lastKnownVersion: 1,
      reason: "target-replaced",
    });

    expect(remote.getStatus()).toMatchObject({
      type: "ready",
      storeInstanceId: "store-terminal-instance-guard",
      version: 1,
    });
    const action = remote.actions.increment();
    onSync({
      type: "snapshot",
      storeInstanceId: "store-terminal-instance-guard",
      version: 2,
      state: { count: 2 },
    });
    await expect(action).resolves.toBe(2);
  });

  it("rejects pending version waiter when terminal envelope arrives before committed snapshot", async () => {
    let onSync!: (event: unknown) => void;
    const dispatchGate = deferred<void>();
    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-terminal-pending-waiter",
          subscriptionId: "sub-terminal-pending-waiter",
          version: 1,
          state: { count: 1 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        await dispatchGate.promise;
        return {
          type: "dispatch-result",
          committedVersion: 2,
          result: 2,
        };
      }),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:terminal-pending-waiter"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: () => 1 }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    const actionPromise = remote.actions.increment();
    dispatchGate.resolve();
    await vi.waitFor(() => {
      expect(service.dispatch).toHaveBeenCalledTimes(1);
    });

    onSync({
      type: "terminal",
      storeInstanceId: "store-terminal-pending-waiter",
      lastKnownVersion: 1,
      reason: "target-replaced",
    });

    await expect(actionPromise).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });

  it("safeConnectNexusStore enforces handshake timeout", async () => {
    const neverService = {
      subscribe: vi.fn(async () => {
        await new Promise<never>(() => undefined);
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    >;

    const timedOut = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof neverService) => any) =>
                next(neverService),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:handshake-timeout"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { target: { descriptor: { context: "background" } as any }, timeout: 10 },
    );

    expect(timedOut.isErr()).toBe(true);
    if (timedOut.isErr()) {
      expect(timedOut.error).toBeInstanceOf(NexusStoreConnectError);
      expect(timedOut.error.message).toMatch(/timed out/i);
    }
  });

  it("safeConnectNexusStore timeout cleans up late baseline and disconnect hook", async () => {
    const baselineGate = deferred<{
      storeInstanceId: string;
      subscriptionId: string;
      version: number;
      state: { count: number };
    }>();
    const cleanupDisconnect = vi.fn();
    const subscribeDisconnect = vi.fn(() => cleanupDisconnect);
    const unsubscribe = vi.fn(async () => {});
    const service = {
      subscribe: vi.fn(async () => baselineGate.promise),
      unsubscribe,
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: subscribeDisconnect,
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    > & {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => () => void;
    };

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof service) => any) => next(service),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:handshake-timeout-cleanup"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      { timeout: 10 },
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreConnectError);
      expect(result.error.message).toMatch(/timed out/i);
    }

    baselineGate.resolve({
      storeInstanceId: "store-timeout-cleanup",
      subscriptionId: "sub-timeout-cleanup",
      version: 0,
      state: { count: 0 },
    });
    await vi.waitFor(() => {
      expect(cleanupDisconnect).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenCalledWith("sub-timeout-cleanup");
    });
  });

  it("safeConnectNexusStore malformed baseline cleans up subscription and disconnect hook", async () => {
    const cleanupDisconnect = vi.fn();
    const subscribeDisconnect = vi.fn(() => cleanupDisconnect);
    const unsubscribe = vi.fn(async () => {});
    const service = {
      subscribe: vi.fn(async () => ({
        storeInstanceId: "store-bad-baseline-cleanup",
        subscriptionId: "sub-bad-baseline-cleanup",
        version: "invalid",
        state: { count: 0 },
      })),
      unsubscribe,
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: subscribeDisconnect,
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    > & {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => () => void;
    };

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof service) => any) => next(service),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:bad-baseline-cleanup"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      {},
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreProtocolError);
    }

    expect(unsubscribe).toHaveBeenCalledWith("sub-bad-baseline-cleanup");
    expect(cleanupDisconnect).toHaveBeenCalledTimes(1);
  });

  it("safeConnectNexusStore classifies throwy baseline getters as protocol errors", async () => {
    const parseThrow = new Error("baseline-getter-throw");
    const cleanupDisconnect = vi.fn();
    const subscribeDisconnect = vi.fn(() => cleanupDisconnect);
    const unsubscribe = vi.fn(async () => {});
    const service = {
      subscribe: vi.fn(async () => ({
        storeInstanceId: "store-throwy-baseline",
        subscriptionId: "sub-throwy-baseline",
        get version() {
          throw parseThrow;
        },
        state: { count: 0 },
      })),
      unsubscribe,
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: subscribeDisconnect,
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    > & {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => () => void;
    };

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof service) => any) => next(service),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:throwy-baseline-cleanup"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      {},
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreProtocolError);
      expect(result.error.cause).toBe(parseThrow);
    }

    expect(unsubscribe).toHaveBeenCalledWith("sub-throwy-baseline");
    expect(cleanupDisconnect).toHaveBeenCalledTimes(1);
  });

  it("safeConnectNexusStore early subscribe rejection cleans disconnect hook without unsubscribe leak", async () => {
    const cleanupDisconnect = vi.fn();
    const subscribeDisconnect = vi.fn(() => cleanupDisconnect);
    const unsubscribe = vi.fn(async () => {});
    const rejection = new Error("subscribe rejected early");
    const service = {
      subscribe: vi.fn(async () => {
        throw rejection;
      }),
      unsubscribe,
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 0,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: subscribeDisconnect,
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { noop(): number }
    > & {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => () => void;
    };

    const result = await safeConnectNexusStore(
      {
        safeCreate: () =>
          ({
            mapErr: () => ({
              andThen: (next: (value: typeof service) => any) => next(service),
            }),
          }) as any,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:early-reject-cleanup"),
        state: () => ({ count: 0 }),
        actions: () => ({ noop: () => 0 }),
      }),
      {},
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusStoreProtocolError);
      expect(result.error.message).toBe("subscribe rejected early");
      expect(result.error.cause).toBe(rejection);
    }

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(cleanupDisconnect).toHaveBeenCalledTimes(1);
  });

  it("disconnect behavior composes with host cleanup capability", async () => {
    const definition = createCounterDefinition();
    const registration = provideNexusStore(definition);

    const setup = await createL3Endpoints(
      {
        meta: { id: "host" },
        services: {
          [definition.token.id]: registration.implementation,
        },
      },
      {
        meta: { id: "client" },
      },
    );

    const fakeNexus = {
      create: async () =>
        (setup.clientEngine as any).proxyFactory.createServiceProxy(
          definition.token.id,
          {
            target: {
              connectionId: (setup.clientConnection as { connectionId: string })
                .connectionId,
            },
          },
        ),
    };

    const remote = await connectNexusStore(fakeNexus as any, definition, {
      target: { descriptor: { id: "host" } as any },
    });
    await remote.actions.increment(1);
    expect(remote.getState().count).toBe(1);

    (setup.clientConnection as { close(): void }).close();
    await vi.waitFor(() => {
      expect(
        Array.from((setup.hostCm as any).connections.values()),
      ).toHaveLength(0);
    });

    await expect(remote.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );

    await expect(
      registration.implementation.dispatch("increment", [1]),
    ).resolves.toMatchObject({ result: 2, committedVersion: 2 });
  });

  it("marks remote store disconnected on idle connection-close notification", async () => {
    let onSync!: (event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: { count: number };
    }) => void;
    let emitDisconnect!: () => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-idle-disconnect",
          subscriptionId: "sub-idle-disconnect",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => ({
        type: "dispatch-result",
        committedVersion: 1,
        result: 1,
      })),
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => {
        emitDisconnect = callback;
        return () => undefined;
      },
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    > & {
      [NEXUS_SUBSCRIBE_CONNECTION_DISCONNECT_SYMBOL]: (
        callback: () => void,
      ) => () => void;
    };

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:idle-disconnect-notification"),
        state: () => ({ count: 0 }),
        actions: () => ({
          increment: (by: number) => by,
        }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    expect(remote.getStatus().type).toBe("ready");
    emitDisconnect();

    expect(remote.getStatus().type).toBe("disconnected");
    await expect(remote.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreDisconnectedError,
    );
  });

  it("remote action path classifies throwy snapshot getters as protocol disconnect", async () => {
    const parseThrow = new Error("snapshot-getter-throw");
    let onSync!: (event: unknown) => void;

    const service = {
      subscribe: vi.fn(async (callback: typeof onSync) => {
        onSync = callback;
        return {
          storeInstanceId: "store-throwy-snapshot",
          subscriptionId: "sub-throwy-snapshot",
          version: 0,
          state: { count: 0 },
        };
      }),
      unsubscribe: vi.fn(async () => {}),
      dispatch: vi.fn(async () => {
        onSync({
          type: "snapshot",
          get storeInstanceId() {
            throw parseThrow;
          },
          version: 1,
          state: { count: 1 },
        });

        return {
          type: "dispatch-result",
          committedVersion: 1,
          result: 1,
        };
      }),
    } as unknown as NexusStoreServiceContract<
      { count: number },
      { increment(by: number): number }
    >;

    const remote = await connectNexusStore(
      {
        create: async () => service,
      } as any,
      defineNexusStore({
        token: new Token("state:counter:throwy-snapshot-disconnect"),
        state: () => ({ count: 0 }),
        actions: () => ({ increment: (by: number) => by }),
      }),
      { target: { descriptor: { context: "background" } as any } },
    );

    await expect(remote.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );
    await expect(remote.actions.increment(1)).rejects.toBeInstanceOf(
      NexusStoreProtocolError,
    );
    expect(remote.getStatus().type).toBe("disconnected");
  });
});

import { describe, expect, expectTypeOf, it } from "vitest";
import { Token } from "../api/token";
import * as core from "../index";
import * as state from "./index";
import type {
  ActionArgs,
  ActionResult,
  ConnectNexusStoreOptions,
  NexusStoreDefinition,
  RemoteActions,
  RemoteStore,
  RemoteStoreStatus,
} from "./index";
import { z } from "zod";

describe("state protocol schemas", () => {
  it("requires subscribe baseline envelope fields", async () => {
    const protocol = await import("./protocol");
    const valid = protocol.SubscribeResultSchema.safeParse({
      storeInstanceId: "instance-1",
      subscriptionId: "sub-1",
      version: 0,
      state: { count: 1 },
    });
    expect(valid.success).toBe(true);

    const missingSubscriptionId = protocol.SubscribeResultSchema.safeParse({
      storeInstanceId: "instance-1",
      version: 0,
      state: { count: 1 },
    });
    expect(missingSubscriptionId.success).toBe(false);
  });

  it("requires snapshot envelope shape", async () => {
    const protocol = await import("./protocol");
    const valid = protocol.SnapshotEnvelopeSchema.safeParse({
      type: "snapshot",
      storeInstanceId: "instance-1",
      version: 2,
      state: { count: 2 },
    });
    expect(valid.success).toBe(true);

    const invalidType = protocol.SnapshotEnvelopeSchema.safeParse({
      type: "patch",
      storeInstanceId: "instance-1",
      version: 2,
      state: { count: 2 },
    });
    expect(invalidType.success).toBe(false);
  });

  it("validates dispatch request payload envelope", async () => {
    const protocol = await import("./protocol");
    const valid = protocol.DispatchRequestEnvelopeSchema.safeParse({
      type: "dispatch-request",
      action: "increment",
      args: [1],
    });
    expect(valid.success).toBe(true);

    const invalidArgs = protocol.DispatchRequestEnvelopeSchema.safeParse({
      type: "dispatch-request",
      action: "increment",
      args: "not-array",
    });
    expect(invalidArgs.success).toBe(false);
  });

  it("validates dispatch result envelope", async () => {
    const protocol = await import("./protocol");
    const valid = protocol.DispatchResultEnvelopeSchema.safeParse({
      type: "dispatch-result",
      committedVersion: 1,
      result: { count: 1 },
    });
    expect(valid.success).toBe(true);

    const invalidCommittedVersion =
      protocol.DispatchResultEnvelopeSchema.safeParse({
        type: "dispatch-result",
        committedVersion: "1",
        result: { count: 1 },
      });
    expect(invalidCommittedVersion.success).toBe(false);
  });

  it("provides schema boundary for connect options", async () => {
    const protocol = await import("./protocol");
    const valid = protocol.ConnectNexusStoreOptionsSchema.safeParse({
      target: {
        descriptor: { context: "background" },
        matcher: "active",
      },
      timeout: 1000,
    });
    expect(valid.success).toBe(true);

    const invalidTimeout = protocol.ConnectNexusStoreOptionsSchema.safeParse({
      timeout: -1,
    });
    expect(invalidTimeout.success).toBe(false);
  });

  it("keeps protocol schemas internal to state public entrypoint", () => {
    expect((state as Record<string, unknown>).SubscribeResultSchema).toBe(
      undefined,
    );
    expect((state as Record<string, unknown>).SnapshotEnvelopeSchema).toBe(
      undefined,
    );
    expect(
      (state as Record<string, unknown>).DispatchRequestEnvelopeSchema,
    ).toBe(undefined);
    expect(
      (state as Record<string, unknown>).DispatchResultEnvelopeSchema,
    ).toBe(undefined);
  });
});

describe("defineNexusStore", () => {
  it("rejects non-Token token inputs", () => {
    expect(() =>
      state.defineNexusStore({
        token: { id: "not-a-token" } as unknown as Token<unknown>,
        state: () => ({ count: 0 }),
        actions: () => ({
          increment() {},
        }),
      }),
    ).toThrowError();
  });

  it("normalizes authoring defaultTarget to token metadata", () => {
    type CounterState = { count: number };
    type CounterActions = { increment(by: number): void };

    const token = new Token<unknown>("state:counter");
    const definition = state.defineNexusStore<CounterState, CounterActions>({
      token,
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by) {
          setState({ count: getState().count + by });
        },
      }),
      defaultTarget: {
        descriptor: { context: "background" },
      },
      sync: {
        mode: "snapshot",
      },
    });

    expect(definition.token.id).toBe("state:counter");
    expect(definition.token).not.toBe(token);
    expect(definition.token.defaultTarget).toEqual({
      descriptor: { context: "background" },
    });
    expect("defaultTarget" in definition).toBe(false);
  });

  it("merges token and authoring defaultTarget with authoring precedence", () => {
    const baseMatcher = (identity: { context: string }) =>
      identity.context === "content";
    const authorMatcher = (identity: { context: string }) =>
      identity.context === "background";

    const token = new Token<unknown>("state:counter:merge", {
      descriptor: { context: "content" },
      matcher: baseMatcher,
    });

    const definition = state.defineNexusStore({
      token,
      state: () => ({ count: 0 }),
      actions: () => ({
        increment() {},
      }),
      defaultTarget: {
        descriptor: { context: "background" },
        matcher: authorMatcher,
      },
    });

    expect(definition.token.defaultTarget).toEqual({
      descriptor: { context: "background" },
      matcher: authorMatcher,
    });
  });

  it("keeps original token when defaultTarget is omitted", () => {
    type CounterState = { count: number };
    type CounterActions = { reset(): void };

    const token = new Token<unknown>("state:counter:2");
    const definition = state.defineNexusStore<CounterState, CounterActions>({
      token,
      state: () => ({ count: 0 }),
      actions: ({ setState }) => ({
        reset() {
          setState({ count: 0 });
        },
      }),
    });

    expect(definition.token).toBe(token);
  });

  it("rejects unsupported sync mode", () => {
    const token = new Token<unknown>("state:counter:3");

    expect(() =>
      state.defineNexusStore({
        token,
        state: () => ({ count: 0 }),
        actions: () => ({
          increment() {},
        }),
        sync: {
          mode: "patch" as "snapshot",
        },
      }),
    ).toThrowError();
  });
});

describe("state public types", () => {
  it("exposes discriminated remote store status", () => {
    expectTypeOf<RemoteStoreStatus>().toMatchTypeOf<
      | { type: "initializing" }
      | { type: "ready"; storeInstanceId: string; version: number }
      | {
          type: "disconnected";
          lastKnownVersion: number | null;
          cause?: Error;
        }
      | {
          type: "stale";
          lastKnownVersion: number | null;
          reason: "target-changed";
        }
      | { type: "destroyed" }
    >();
  });

  it("defines the public store contract shape", () => {
    type CounterState = { count: number };
    type CounterActions = { inc(by?: number): Promise<void> };

    expectTypeOf<
      NexusStoreDefinition<CounterState, CounterActions>["state"]
    >().toEqualTypeOf<() => CounterState>();
    expectTypeOf<
      ReturnType<NexusStoreDefinition<CounterState, CounterActions>["actions"]>
    >().toEqualTypeOf<CounterActions>();

    type HasDefaultTarget = "defaultTarget" extends keyof NexusStoreDefinition<
      CounterState,
      CounterActions
    >
      ? true
      : false;

    expectTypeOf<HasDefaultTarget>().toEqualTypeOf<false>();
  });

  it("types remote actions as promise-returning regardless of author action sync/async style", () => {
    type CounterActions = {
      increment(by: number): number;
      reset(): Promise<void>;
    };

    expectTypeOf<RemoteActions<CounterActions>>().toMatchTypeOf<{
      increment(by: number): Promise<number>;
      reset(): Promise<void>;
    }>();

    expectTypeOf<
      RemoteStore<{ count: number }, CounterActions>["actions"]
    >().toEqualTypeOf<RemoteActions<CounterActions>>();
  });

  it("infers action argument and result types", () => {
    type CounterActions = {
      inc(by: number, label?: string): Promise<{ value: number }>;
      reset(): void;
    };

    expectTypeOf<ActionArgs<CounterActions, "inc">>().toEqualTypeOf<
      [by: number, label?: string]
    >();
    expectTypeOf<ActionResult<CounterActions, "inc">>().toEqualTypeOf<{
      value: number;
    }>();
    expectTypeOf<ActionResult<CounterActions, "reset">>().toEqualTypeOf<void>();
  });

  it("exposes connect options public type", () => {
    expectTypeOf<
      ConnectNexusStoreOptions<{ context: string }, "active", "background">
    >().toMatchTypeOf<{
      target?: {
        descriptor?: "background" | { context?: string };
        matcher?: "active" | ((identity: { context: string }) => boolean);
      };
      timeout?: number;
    }>();
  });

  it("exports state errors from the state entrypoint", () => {
    expect(typeof state.NexusStoreError).toBe("function");
    expect(typeof state.NexusStoreConnectError).toBe("function");
    expect(typeof state.NexusStoreDisconnectedError).toBe("function");
    expect(typeof state.NexusStoreActionError).toBe("function");
    expect(typeof state.NexusStoreProtocolError).toBe("function");
    expect(typeof state.normalizeNexusStoreError).toBe("function");
  });

  it("keeps state error symbols scoped to the state entrypoint", () => {
    expect((core as Record<string, unknown>).NexusStoreConnectError).toBe(
      undefined,
    );
    expect((core as Record<string, unknown>).NexusStoreProtocolError).toBe(
      undefined,
    );
    expect((core as Record<string, unknown>).normalizeNexusStoreError).toBe(
      undefined,
    );
  });

  it("keeps stale marker symbol internal to state entrypoint", () => {
    expect(
      (state as Record<string, unknown>).NEXUS_MARK_REMOTE_STORE_STALE_SYMBOL,
    ).toBe(undefined);
  });

  it("supports optional validation schemas in store definitions", () => {
    type CounterState = { count: number };
    type CounterActions = {
      increment(by: number): number;
      reset(): Promise<void>;
    };

    expectTypeOf<
      NonNullable<
        NexusStoreDefinition<CounterState, CounterActions>["validation"]
      >["state"]
    >().toEqualTypeOf<z.ZodType<CounterState> | undefined>();
    expectTypeOf<
      NonNullable<
        NexusStoreDefinition<CounterState, CounterActions>["validation"]
      >["actionResults"]
    >().toEqualTypeOf<
      | {
          increment?: z.ZodType<number>;
          reset?: z.ZodType<void>;
        }
      | undefined
    >();
  });
});

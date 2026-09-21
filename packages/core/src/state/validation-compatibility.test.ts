import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { z } from "zod";
import * as zm from "zod/mini";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createNexusStore } from "./bind-store";
import { createStoreToken, type StoreValidationSchemas } from "./contract";

type State = { count: number };
type Actions = { increment(by: number): number };

const trackValidation = <Schema extends StandardSchemaV1>(
  schema: Schema,
  calls: { count: number },
): Schema =>
  ({
    "~standard": {
      ...schema["~standard"],
      validate(value: unknown, options?: StandardSchemaV1.Options) {
        calls.count += 1;
        return schema["~standard"].validate(value, options);
      },
    },
  }) as Schema;

const createStore = (validation: StoreValidationSchemas<State & Actions>) =>
  createNexusStore<State & Actions>(
    createStoreToken<State & Actions>(`state:compat:${Math.random()}`, {
      validation,
    }),
    (set, get) => ({
      count: 0,
      increment(by: number) {
        set({ count: get().count + by });
        return get().count;
      },
    }),
    { snapshot: ({ count }) => ({ count }), expose: ["increment"] },
  );

describe("State validation compatibility", () => {
  it.each([
    [
      "Valibot",
      v.pipe(
        v.object({ count: v.number() }),
        v.transform(({ count }) => ({ count: count + 1 })),
      ),
      v.pipe(
        v.number(),
        v.transform((value) => value + 1),
      ),
    ],
    [
      "Zod",
      z
        .object({ count: z.number() })
        .transform(({ count }) => ({ count: count + 1 })),
      z.number().transform((value) => value + 1),
    ],
    [
      "Zod Mini",
      zm.pipe(
        zm.object({ count: zm.number() }),
        zm.transform(({ count }) => ({ count: count + 1 })),
      ),
      zm.pipe(
        zm.number(),
        zm.transform((value) => value + 1),
      ),
    ],
  ])(
    "executes %s Standard Schema validation",
    async (_name, state, actionResult) => {
      const stateCalls = { count: 0 };
      const actionCalls = { count: 0 };
      const binding = createStore({
        state: trackValidation(state, stateCalls),
        actionResults: {
          increment: trackValidation(actionResult, actionCalls),
        },
      });
      try {
        let initialState!: State;
        let actions!: { increment(by: number): Promise<number> };
        await binding.provider.service.subscribe((event) => {
          if (event.type === "init") {
            initialState = event.state;
            actions = event.actions;
          }
        });
        expect(initialState).toEqual({ count: 0 });
        expect(stateCalls.count).toBeGreaterThan(0);

        await expect(actions.increment(1)).resolves.toBe(1);
        expect(actionCalls.count).toBeGreaterThan(0);
        expect(binding.store.getState().count).toBe(1);
      } finally {
        binding.destroy();
      }
    },
  );

  it("accepts output-constrained transforms without installing transformed values", async () => {
    const binding = createStore({
      state: v.pipe(
        v.object({ count: v.number() }),
        v.transform(({ count }) => ({ count: count + 1 })),
      ),
      actionResults: {
        increment: v.pipe(
          v.number(),
          v.transform((value) => value + 1),
        ),
      },
    });
    try {
      let initial!: { actions: { increment(by: number): Promise<number> } };
      await binding.provider.service.subscribe((event) => {
        if (event.type === "init") initial = event;
      });
      await expect(initial.actions.increment(1)).resolves.toBe(1);
      expect(binding.store.getState().count).toBe(1);
    } finally {
      binding.destroy();
    }
  });

  it.each([
    [
      "Valibot",
      v.object({ count: v.pipe(v.number(), v.minValue(1)) }),
      v.pipe(v.number(), v.maxValue(0)),
    ],
    ["Zod", z.object({ count: z.number().min(1) }), z.number().max(0)],
    [
      "Zod Mini",
      zm.object({ count: zm.number().check(zm.minimum(1)) }),
      zm.number().check(zm.maximum(0)),
    ],
  ])(
    "rejects invalid %s state and action results through the protocol boundary",
    async (_name, state, actionResult) => {
      const stateCalls = { count: 0 };
      const actionCalls = { count: 0 };
      const binding = createStore({
        state: trackValidation(state, stateCalls),
        actionResults: {
          increment: trackValidation(actionResult, actionCalls),
        },
      });
      try {
        await expect(
          binding.provider.service.subscribe(() => undefined),
        ).rejects.toMatchObject({ code: "E_STORE_PROTOCOL" });
        expect(stateCalls.count).toBeGreaterThan(0);

        const validStateCalls = { count: 0 };
        const validActionCalls = { count: 0 };
        const validBinding = createStore({
          state: trackValidation(
            v.object({ count: v.number() }),
            validStateCalls,
          ),
          actionResults: {
            increment: trackValidation(actionResult, validActionCalls),
          },
        });
        try {
          let initial!: { actions: { increment(by: number): Promise<number> } };
          await validBinding.provider.service.subscribe((event) => {
            if (event.type === "init") initial = event;
          });
          await expect(initial.actions.increment(1)).rejects.toMatchObject({
            code: "E_STORE_PROTOCOL",
          });
          expect(validStateCalls.count).toBeGreaterThan(0);
          expect(validActionCalls.count).toBeGreaterThan(0);
          expect(validBinding.store.getState().count).toBe(1);
        } finally {
          validBinding.destroy();
        }
      } finally {
        binding.destroy();
      }
    },
  );
});

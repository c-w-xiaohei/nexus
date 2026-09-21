import { Result } from "better-result";
import { describe, expect, it } from "vitest";
import {
  literal,
  number,
  object,
  pipe,
  safeParse,
  string,
  transform,
} from "valibot";
import { args, fn, SchemaValidationError } from "./fn";

describe("fn", () => {
  it("accepts Valibot schemas and preserves input/output inference at runtime", () => {
    const schema = object({ value: string() });
    const read = fn(schema, (input) => input.value.length);

    const result = read({ value: "nexus" });

    expect(result.unwrap()).toBe(5);
    expect(read.schema).toBe(schema);
  });

  it("maps named tuple inputs, exposes force, and wraps async results", async () => {
    const add = fn(
      args([
        ["left", number()],
        ["right", number()],
      ] as const),
      async (left, right) => left + right,
    );

    expect((await add(2, 3)).unwrap()).toBe(5);
    expect(await add.force(2, 3)).toBe(5);
  });

  it("preserves an existing Result returned by the callback", () => {
    const schema = object({ ok: literal(true) });
    const expected = Result.ok("value");
    const run = fn(schema, () => expected);

    expect(run({ ok: true })).toBe(expected);
  });

  it("maps tuple transforms once and preserves callback Results and force behavior", async () => {
    let transforms = 0;
    const schema = pipe(
      string(),
      transform((value) => {
        transforms++;
        return Number(value);
      }),
    );
    const expected = Result.err("business failure");
    const received: unknown[] = [];
    const run = fn(args([["value", schema]] as const), async (value) => {
      received.push(value);
      return expected;
    });

    expect(await run("4")).toBe(expected);
    expect(transforms).toBe(1);
    expect(received).toEqual([4]);
    expect(await run.force("raw")).toBe(expected);
    expect(transforms).toBe(1);
    expect(received).toEqual([4, "raw"]);
    expect(safeParse(run.schema, { value: "5" }).output).toEqual({ value: 5 });

    const cause = new Error("tuple handler failure");
    const fail = fn(args([["value", number()]] as const), () => {
      throw cause;
    });
    expect(() => fail(1)).toThrow(cause);
  });

  it("returns schema issues without retaining a Valibot-specific error object", () => {
    const run = fn(object({ value: string() }), (input) => input.value);
    const result = run({ value: 1 });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(SchemaValidationError);
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error).not.toHaveProperty("zodError");
      expect(result.error.cause).toEqual({ issues: result.error.issues });
    }
  });

  it("contains getter and transform exceptions at the validation boundary", () => {
    const getterCause = new Error("getter-boom");
    const input = {};
    Object.defineProperty(input, "value", {
      get: () => {
        throw getterCause;
      },
    });
    const read = fn(object({ value: string() }), (value) => value.value);

    const getterResult = read(input);

    expect(getterResult.isErr()).toBe(true);
    if (getterResult.isErr()) {
      expect(getterResult.error.cause).toBe(getterCause);
      expect(getterResult.error.issues).toEqual([]);
    }

    const transformCause = new Error("transform-boom");
    const convert = fn(
      pipe(
        string(),
        transform(() => {
          throw transformCause;
        }),
      ),
      (value) => value,
    );
    const transformResult = convert("value");

    expect(transformResult.isErr()).toBe(true);
    if (transformResult.isErr()) {
      expect(transformResult.error.cause).toBe(transformCause);
      expect(transformResult.error.issues).toEqual([]);
    }
  });

  it("contains tuple schema exceptions without converting handler exceptions", () => {
    const transformCause = new Error("tuple-transform-boom");
    const convert = fn(
      args([
        [
          "value",
          pipe(
            string(),
            transform(() => {
              throw transformCause;
            }),
          ),
        ],
      ] as const),
      (value) => value,
    );

    const result = convert("value");

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.cause).toBe(transformCause);
    }

    const handlerCause = new Error("handler-boom");
    const run = fn(object({ value: string() }), () => {
      throw handlerCause;
    });
    expect(() => run({ value: "value" })).toThrow(handlerCause);
  });

  it("uses transformed output for callbacks while keeping schema validation safe", () => {
    const schema = pipe(
      string(),
      transform((value) => Number(value)),
    );
    const run = fn(schema, (value) => value + 1);

    expect(run("4").unwrap()).toBe(5);
    expect(safeParse(schema, "4").success).toBe(true);
  });
});

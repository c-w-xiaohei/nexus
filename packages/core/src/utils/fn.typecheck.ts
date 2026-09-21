import type { Result } from "better-result";
import { expectTypeOf } from "vitest";
import * as v from "valibot";
import { args, fn, type SchemaValidationError } from "./fn";

const numericString = v.pipe(v.string(), v.transform(Number));
const parse = fn(numericString, (value) => {
  expectTypeOf(value).toEqualTypeOf<number>();
  return value;
});
expectTypeOf(parse).parameter(0).toEqualTypeOf<string>();
expectTypeOf(parse).returns.toEqualTypeOf<
  Result<number, SchemaValidationError>
>();

const add = fn(
  args([
    ["left", numericString],
    ["right", v.number()],
  ] as const),
  async (left, right) => {
    expectTypeOf(left).toEqualTypeOf<number>();
    expectTypeOf(right).toEqualTypeOf<number>();
    return left + right;
  },
);
expectTypeOf(add).parameters.toEqualTypeOf<[left: string, right: number]>();
expectTypeOf(add).returns.toEqualTypeOf<
  Promise<Result<number, SchemaValidationError>>
>();

if (false) {
  // @ts-expect-error Callers supply schema input, not transformed output.
  parse(1);
  // @ts-expect-error Named tuple arguments retain their individual input types.
  add(1, "2");
}

import { Result } from "better-result";
const { err, ok } = Result;
import {
  object,
  safeParse,
  type BaseIssue,
  type GenericSchema,
  type InferInput,
  type InferOutput,
} from "valibot";

/**
 * Schema validation error
 * Thrown when function parameter validation fails
 */
export class SchemaValidationError extends Error {
  readonly name = "SchemaValidationError";
  constructor(
    message: string,
    readonly code: "VALIDATION_FAILED",
    readonly issues: readonly BaseIssue<unknown>[],
    cause: unknown = { issues },
  ) {
    super(message);
    this.cause = cause;
  }

  readonly cause: unknown;
}

/**
 * Function return type transformation
 * Wraps function return values into Result type
 */
type FnResult<R> =
  R extends Promise<Result<infer U, infer E>>
    ? Promise<Result<U, E | SchemaValidationError>>
    : R extends Result<infer U, infer E>
      ? Result<U, E | SchemaValidationError>
      : R extends Promise<infer U>
        ? Promise<Result<U, SchemaValidationError>>
        : Result<R, SchemaValidationError>;

/**
 * Enhanced function type returned by fn()
 * Contains the original function, force method, and schema property
 */
export type Fn<C extends (...args: any[]) => any> = C & {
  /** Skip validation and execute the original function directly */
  force: (...args: any[]) => any;
  /** The Valibot schema used by this function */
  schema: GenericSchema;
};

/**
 * Parameter type relabeling
 * Relabels function parameter types from From to To
 */
type Relabel<From extends readonly unknown[], To extends readonly unknown[]> = {
  [I in keyof From]: I extends keyof To ? To[I] : never;
};

/**
 * Check if a value is a Result type
 */
const isResult = (value: unknown): value is Result<unknown, unknown> =>
  value !== null &&
  typeof value === "object" &&
  "isOk" in value &&
  "isErr" in value;

/**
 * Check if a value is a Promise-like object
 */
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown })?.then === "function";

/**
 * Wrap function return value into Result type
 * - If already a Result, return as-is
 * - If a Promise, await and wrap
 * - Otherwise wrap as ok(value)
 */
const wrapResult = (value: unknown) => {
  if (isPromiseLike(value)) {
    return Promise.resolve(value).then((resolved) =>
      isResult(resolved) ? resolved : ok(resolved),
    );
  }

  return isResult(value) ? value : ok(value);
};

// Tuple schema types
type TupleSchema = readonly (readonly [string, GenericSchema])[];
type TupleInputArgs<T extends TupleSchema> = {
  [K in keyof T]: InferInput<T[K][1]>;
};
type TupleOutputArgs<T extends TupleSchema> = {
  [K in keyof T]: InferOutput<T[K][1]>;
};

// Keep handler execution outside this boundary: only validation failures become
// SchemaValidationError, including getters and custom transforms that throw.
const validateInput = <T extends GenericSchema>(
  schema: T,
  input: unknown,
): Result<InferOutput<T>, SchemaValidationError> => {
  let parsed;
  try {
    parsed = safeParse(schema, input);
  } catch (cause) {
    return err(
      new SchemaValidationError(
        "Schema validation failed",
        "VALIDATION_FAILED",
        [],
        cause,
      ),
    );
  }
  return parsed.success
    ? ok(parsed.output)
    : err(
        new SchemaValidationError(
          "Schema validation failed",
          "VALIDATION_FAILED",
          parsed.issues,
        ),
      );
};

/**
 * Helper function to define tuple schema with correct type inference
 * Use this when you want to define multi-argument functions with fn()
 *
 * @example
 * const schema = args([
 *   ['name', string()],
 *   ['age', number()],
 * ] as const)
 *
 * const greet = fn(schema, (name, age) => `Hello ${name}, you are ${age}`)
 */
export function args<T extends TupleSchema>(schema: T): T {
  return schema;
}

/**
 * Create a type-safe function wrapper
 *
 * The fn function accepts a Valibot schema and a callback function, returning an enhanced function that:
 * - Automatically validates input parameters
 * - Wraps return values into Result type
 * - Provides a force method to skip validation
 *
 * Supports two schema forms:
 * 1. TupleSchema (recommended): Use args() to define multi-parameter functions
 * 2. Valibot schema: Single parameter functions
 *
 * @example
 * // Multi-parameter function (recommended with args)
 * const add = fn(
 *   args([
 *     ['a', number()],
 *     ['b', number()],
 *   ] as const),
 *   (a, b) => a + b
 * )
 * const result = add(1, 2) // Result<number, SchemaValidationError>
 *
 * @example
 * // Single parameter function
 * const validate = fn(
 *   object({ name: string() }),
 *   (input) => input
 * )
 * const result = validate({ name: 'Alice' })
 *
 * @example
 * // Skip validation
 * const result = add.force(1, 2) // Returns 3 directly, not wrapped in Result
 */
export function fn<
  T extends TupleSchema,
  C extends (...args: TupleOutputArgs<T>) => any,
>(
  schema: T,
  cb: C,
): Fn<
  (
    ...args: Relabel<Parameters<C>, TupleInputArgs<T>>
  ) => FnResult<ReturnType<C>>
>;
export function fn<
  T extends GenericSchema,
  C extends (input: InferOutput<T>) => any,
>(schema: T, cb: C): Fn<(input: InferInput<T>) => FnResult<ReturnType<C>>>;
export function fn(
  schema: GenericSchema | TupleSchema,
  cb: (...args: any[]) => any,
): any {
  // Handle a Valibot schema (single parameter).
  if (!Array.isArray(schema)) {
    const singleSchema = schema as GenericSchema;
    const result = ((input: unknown) => {
      const parsed = validateInput(singleSchema, input);
      if (parsed.isErr()) return parsed;
      return wrapResult(cb(parsed.value));
    }) as Fn<(input: unknown) => unknown>;

    result.force = (input: unknown) => cb(input);
    result.schema = singleSchema;

    return result;
  }

  // Handle TupleSchema (array of [key, schema] pairs)
  const keys = schema.map(([key]) => key);
  const objectSchema = object(Object.fromEntries(schema));
  const invoke = fn(objectSchema, (input) =>
    cb(...keys.map((key) => input[key])),
  );

  const result = (...args: unknown[]) =>
    invoke(Object.fromEntries(keys.map((key, index) => [key, args[index]])));

  result.force = (...args: unknown[]) => cb(...args);
  result.schema = objectSchema;

  return result;
}

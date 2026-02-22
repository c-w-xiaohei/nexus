import { err, ok, type Result } from 'neverthrow'
import { z } from 'zod'

/**
 * Schema validation error
 * Thrown when function parameter validation fails
 */
export class SchemaValidationError extends Error {
  readonly name = 'SchemaValidationError'
  constructor(
    message: string,
    readonly code: 'VALIDATION_FAILED',
    readonly zodError: z.ZodError,
  ) {
    super(message)
  }
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
        : Result<R, SchemaValidationError>

/**
 * Enhanced function type returned by fn()
 * Contains the original function, force method, and schema property
 */
export type Fn<C extends (...args: any[]) => any> = C & {
  /** Skip validation and execute the original function directly */
  force: (...args: any[]) => any
  /** The Zod schema used by this function */
  schema: z.ZodTypeAny
}

/**
 * Parameter type relabeling
 * Relabels function parameter types from From to To
 */
type Relabel<From extends readonly unknown[], To extends readonly unknown[]> = {
  [I in keyof From]: I extends keyof To ? To[I] : never
}

/**
 * Check if a value is a Result type
 */
const isResult = (value: unknown): value is Result<unknown, unknown> =>
  value !== null && typeof value === 'object' && 'isOk' in value && 'isErr' in value

/**
 * Check if a value is a Promise-like object
 */
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown })?.then === 'function'

/**
 * Wrap function return value into Result type
 * - If already a Result, return as-is
 * - If a Promise, await and wrap
 * - Otherwise wrap as ok(value)
 */
const wrapResult = <R>(value: R) => {
  if (isPromiseLike(value)) {
    return Promise.resolve(value).then((resolved) =>
      isResult(resolved) ? resolved : ok(resolved),
    ) as any
  }

  return isResult(value) ? (value as any) : ok(value)
}

// Tuple schema types
type TupleSchema = readonly (readonly [string, z.ZodTypeAny])[]
type TupleInputArgs<T extends TupleSchema> = {
  [K in keyof T]: T[K] extends readonly [string, infer S]
    ? S extends z.ZodTypeAny
      ? z.input<S>
      : never
    : never
}
type TupleOutputArgs<T extends TupleSchema> = {
  [K in keyof T]: T[K] extends readonly [string, infer S]
    ? S extends z.ZodTypeAny
      ? z.infer<S>
      : never
    : never
}

/**
 * Helper function to define tuple schema with correct type inference
 * Use this when you want to define multi-argument functions with fn()
 *
 * @example
 * const schema = args([
 *   ['name', z.string()],
 *   ['age', z.number()],
 * ] as const)
 *
 * const greet = fn(schema, (name, age) => `Hello ${name}, you are ${age}`)
 */
export function args<T extends TupleSchema>(schema: T): T {
  return schema
}

/**
 * Create a type-safe function wrapper
 *
 * The fn function accepts a Zod schema and a callback function, returning an enhanced function that:
 * - Automatically validates input parameters
 * - Wraps return values into Result type
 * - Provides a force method to skip validation
 *
 * Supports two schema forms:
 * 1. TupleSchema (recommended): Use args() to define multi-parameter functions
 * 2. ZodType: Single parameter functions
 *
 * @example
 * // Multi-parameter function (recommended with args)
 * const add = fn(
 *   args([
 *     ['a', z.number()],
 *     ['b', z.number()],
 *   ] as const),
 *   (a, b) => a + b
 * )
 * const result = add(1, 2) // Result<number, SchemaValidationError>
 *
 * @example
 * // Single parameter function
 * const validate = fn(
 *   z.object({ name: z.string() }),
 *   (input) => input
 * )
 * const result = validate({ name: 'Alice' })
 *
 * @example
 * // Skip validation
 * const result = add.force(1, 2) // Returns 3 directly, not wrapped in Result
 */
export function fn<T extends TupleSchema, C extends (...args: TupleOutputArgs<T>) => any>(
  schema: T,
  cb: C,
): Fn<(...args: Relabel<Parameters<C>, TupleInputArgs<T>>) => FnResult<ReturnType<C>>>
export function fn<T extends z.ZodType, C extends (input: z.infer<T>) => any>(
  schema: T,
  cb: C,
): Fn<(input: z.input<T>) => FnResult<ReturnType<C>>>
export function fn(schema: z.ZodTypeAny | TupleSchema, cb: (...args: any[]) => any): any {
  // Handle ZodType (single parameter)
  if (schema instanceof z.ZodType) {
    const result = ((input: unknown) => {
      const parsed = schema.safeParse(input)
      if (!parsed.success) {
        return err(
          new SchemaValidationError('Schema validation failed', 'VALIDATION_FAILED', parsed.error),
        ) as any
      }

      const value = cb(parsed.data)
      return wrapResult(value)
    }) as Fn<(input: unknown) => unknown>

    result.force = (input: unknown) => cb(input)
    result.schema = schema

    return result
  }

  // Handle TupleSchema (array of [key, schema] pairs)
  if (Array.isArray(schema)) {
    const keys = schema.map(([key]) => key)
    const objectSchema = z.object(Object.fromEntries(schema))

    const result = ((...args: unknown[]) => {
      const rawInput = Object.fromEntries(keys.map((key, index) => [key, args[index]]))
      const parsed = objectSchema.safeParse(rawInput)
      if (!parsed.success) {
        return err(
          new SchemaValidationError('Schema validation failed', 'VALIDATION_FAILED', parsed.error),
        ) as any
      }

      const value = cb(...(keys.map((key) => (parsed.data as any)[key]) as unknown[]))
      return wrapResult(value)
    }) as unknown as Fn<(...args: unknown[]) => unknown>

    result.force = (...args: unknown[]) => cb(...(args as unknown[]))
    result.schema = objectSchema

    return result
  }

  // This should never happen if TypeScript types are correct
  throw new Error('Invalid schema type')
}

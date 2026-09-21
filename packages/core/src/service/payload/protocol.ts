import {
  array,
  length,
  minLength,
  pipe,
  safeParse,
  string,
  strictTuple,
  unknown,
  type GenericSchema,
  type InferOutput,
} from "valibot";

/**
 * The single source of truth for the Nexus JSON-based payload protocol.
 * This defines the special placeholder format used to encode non-serializable
 * JavaScript types into strings.
 */

/**
 * Control-character prefix; matching user strings are escaped before transport.
 */
export const PLACEHOLDER_PREFIX = "\u0003";

/**
 * The character used to escape user data that happens to start with
 * the PLACEHOLDER_PREFIX or the ESCAPE_CHAR itself.
 */
export const ESCAPE_CHAR = "\u0004";

/**
 * The separator between the placeholder type code and its payload.
 */
export const PAYLOAD_SEPARATOR = ":";

/**
 * An enumeration of all special types that can be represented as placeholders.
 * The single-character codes are used for maximum compression.
 */
export enum PlaceholderType {
  RESOURCE = "R", // Represents a function or @Ref object proxy
  UNDEFINED = "U",
  MAP = "M",
  SET = "S",
  BIGINT = "N",
}

const jsonValueSchema = unknown();
// unknown() accepts missing tuple slots, so validate arity before tuple parsing.
const mapEntriesSchema = array(
  pipe(
    array(jsonValueSchema),
    length(2),
    strictTuple([jsonValueSchema, jsonValueSchema]),
  ),
);
const setValuesSchema = array(jsonValueSchema);
const resourceIdSchema = pipe(string(), minLength(1));

function parseJsonPayload<TSchema extends GenericSchema>(
  payload: string,
  schema: TSchema,
  label: string,
): InferOutput<TSchema> {
  const parsed = JSON.parse(payload) as unknown;
  const result = safeParse(schema, parsed);
  if (!result.success) throw new TypeError(`Invalid ${label} payload.`);
  return result.output;
}

export function validateResourceId(payload: string): string {
  const result = safeParse(resourceIdSchema, payload);
  if (!result.success)
    throw new TypeError("Resource placeholder requires a non-empty ID.");
  return result.output;
}

// Pure value decoders; resource revival belongs to the owning payload transaction.
export const REVIVER_TABLE_CONFIG = new Map<
  string,
  (payload: string) => unknown
>([
  [
    PlaceholderType.MAP,
    (payload) =>
      new Map(parseJsonPayload(payload, mapEntriesSchema, "Map entries")),
  ],
  [
    PlaceholderType.SET,
    (payload) =>
      new Set(parseJsonPayload(payload, setValuesSchema, "Set values")),
  ],
  [PlaceholderType.BIGINT, (payload) => BigInt(payload)],
  [PlaceholderType.UNDEFINED, () => undefined],
]);

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

// Pure value decoders; resource revival belongs to the owning payload transaction.
export const REVIVER_TABLE_CONFIG = new Map<
  string,
  (payload: string) => unknown
>([
  [PlaceholderType.MAP, (payload) => new Map(JSON.parse(payload))],
  [PlaceholderType.SET, (payload) => new Set(JSON.parse(payload))],
  [PlaceholderType.BIGINT, (payload) => BigInt(payload)],
  [PlaceholderType.UNDEFINED, () => undefined],
]);

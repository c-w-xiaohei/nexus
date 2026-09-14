import {
  PLACEHOLDER_PREFIX,
  PAYLOAD_SEPARATOR,
  PlaceholderType,
} from "./protocol.js";

export namespace Placeholder {
  /** Encode a wire tag while preserving an optional opaque payload. */
  export function encode(type: PlaceholderType, payload?: string): string {
    if (payload === undefined) {
      return `${PLACEHOLDER_PREFIX}${type}`;
    }
    return `${PLACEHOLDER_PREFIX}${type}${PAYLOAD_SEPARATOR}${payload}`;
  }

  /** Preserve unknown tags and payload separators for forward-compatible revival. */
  export function fromString(
    value: unknown,
  ): { type: string; payload?: string } | null {
    if (typeof value !== "string" || !value.startsWith(PLACEHOLDER_PREFIX)) {
      return null;
    }
    const body = value.slice(PLACEHOLDER_PREFIX.length);
    const separator = body.indexOf(PAYLOAD_SEPARATOR);
    if (separator === -1) {
      return { type: body };
    }
    return {
      type: body.slice(0, separator),
      payload: body.slice(separator + 1),
    };
  }
}

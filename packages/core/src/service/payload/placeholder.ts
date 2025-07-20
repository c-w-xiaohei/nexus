import {
  PLACEHOLDER_PREFIX,
  PAYLOAD_SEPARATOR,
  PlaceholderType,
} from "./protocol";

/**
 * A class-based representation of a serialized placeholder string.
 * This provides a structured way to create and parse placeholders, avoiding
 * raw string manipulation in the business logic.
 */
export class Placeholder {
  constructor(
    public readonly type: PlaceholderType,
    public readonly payload?: string
  ) {}

  /**
   * Converts the Placeholder instance back into its string representation.
   * @returns The string format, e.g., "\u0003R:res-123" or "\u0003U".
   */
  public toString(): string {
    if (this.payload !== undefined) {
      return `${PLACEHOLDER_PREFIX}${this.type}${PAYLOAD_SEPARATOR}${this.payload}`;
    }
    return `${PLACEHOLDER_PREFIX}${this.type}`;
  }

  /**
   * Attempts to parse a string value into a Placeholder instance.
   * This method uses efficient string operations and avoids regular expressions.
   * @param value The string to parse.
   * @returns A `Placeholder` instance if parsing is successful, otherwise `null`.
   */
  public static fromString(value: unknown): Placeholder | null {
    if (typeof value !== "string" || !value.startsWith(PLACEHOLDER_PREFIX)) {
      return null;
    }

    // e.g., "\u0003R:res-123" -> "R:res-123"
    const body = value.substring(PLACEHOLDER_PREFIX.length);
    const separatorIndex = body.indexOf(PAYLOAD_SEPARATOR);

    if (separatorIndex === -1) {
      // This is a payload-less placeholder, e.g., "\u0003U"
      // The entire body is the type code.
      const type = body as PlaceholderType;
      // You might want to add validation here to ensure `type` is a valid PlaceholderType
      return new Placeholder(type);
    } else {
      // This is a placeholder with a payload.
      const type = body.substring(0, separatorIndex) as PlaceholderType;
      const payload = body.substring(separatorIndex + 1);
      return new Placeholder(type, payload);
    }
  }
}

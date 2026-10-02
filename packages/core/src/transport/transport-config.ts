import * as v from "valibot";

export const DEFAULT_TRANSPORT_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxMessageBytes: 16 * 1024 * 1024,
  maxBufferedBytes: 64 * 1024 * 1024,
});

const positiveSafeInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const transportConfigSchema = v.strictObject({
  binaryPackets: v.boolean(),
  maxFrameBytes: positiveSafeInteger,
  maxMessageBytes: positiveSafeInteger,
  maxBufferedBytes: positiveSafeInteger,
});

export type ResolvedTransportConfig = Readonly<
  v.InferOutput<typeof transportConfigSchema>
>;
export type TransportConfig = Readonly<Partial<ResolvedTransportConfig>>;
export type TransportLimits = Readonly<
  Partial<Pick<ResolvedTransportConfig, keyof typeof DEFAULT_TRANSPORT_LIMITS>>
>;

/**
 * Copy and validate shared limits. Adapters select the packet mode, check their
 * native ceiling and may wrap invalid input in adapter errors.
 */
export function resolveTransportConfig(
  input: TransportLimits | undefined,
  binaryPackets: boolean,
): Readonly<ResolvedTransportConfig> {
  if (input && "binaryPackets" in input)
    throw new TypeError("transport.binaryPackets is not a transport limit.");
  const config = {
    binaryPackets,
    maxFrameBytes:
      input?.maxFrameBytes ?? DEFAULT_TRANSPORT_LIMITS.maxFrameBytes,
    maxMessageBytes:
      input?.maxMessageBytes ?? DEFAULT_TRANSPORT_LIMITS.maxMessageBytes,
    maxBufferedBytes:
      input?.maxBufferedBytes ?? DEFAULT_TRANSPORT_LIMITS.maxBufferedBytes,
  };
  const parsed = v.safeParse(transportConfigSchema, config);
  if (!parsed.success) {
    const field = parsed.issues[0]?.path?.[0]?.key;
    throw new TypeError(
      field === "maxFrameBytes" ||
        field === "maxMessageBytes" ||
        field === "maxBufferedBytes"
        ? `transport.${field} must be a positive safe integer.`
        : "Invalid transport config.",
    );
  }
  if (parsed.output.maxBufferedBytes < parsed.output.maxMessageBytes)
    throw new TypeError(
      "transport.maxBufferedBytes must be at least maxMessageBytes.",
    );
  if (parsed.output.maxMessageBytes > DEFAULT_TRANSPORT_LIMITS.maxMessageBytes)
    throw new TypeError(
      `transport.maxMessageBytes cannot exceed ${DEFAULT_TRANSPORT_LIMITS.maxMessageBytes}.`,
    );
  return Object.freeze(parsed.output);
}

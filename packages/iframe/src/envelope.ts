import * as v from "valibot";

export const MessageEnvelopeSchema = v.looseObject({
  __nexusIframe: v.literal(true),
  appId: v.string(),
  channel: v.string(),
  nonce: v.optional(v.string()),
  payload: v.unknown(),
});

export type MessageEnvelope = v.InferOutput<typeof MessageEnvelopeSchema>;

export function createEnvelope(
  appId: string,
  channel: string,
  payload: unknown,
  nonce?: string,
): MessageEnvelope {
  return {
    __nexusIframe: true,
    appId,
    channel,
    nonce,
    payload,
  };
}

export function readEnvelope(value: unknown): MessageEnvelope | undefined {
  try {
    const candidate = typeof value === "string" ? JSON.parse(value) : value;
    const result = v.safeParse(MessageEnvelopeSchema, candidate);
    return result.success ? result.output : undefined;
  } catch {
    return undefined;
  }
}

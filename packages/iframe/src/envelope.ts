export type MessageEnvelope = {
  __nexusIframe: true;
  appId: string;
  channel: string;
  nonce?: string;
  payload: unknown;
};

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
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<MessageEnvelope>;
  if (
    record.__nexusIframe !== true ||
    typeof record.appId !== "string" ||
    typeof record.channel !== "string"
  )
    return undefined;
  return record as MessageEnvelope;
}

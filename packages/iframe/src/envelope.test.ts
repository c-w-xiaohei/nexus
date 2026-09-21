import { describe, expect, it } from "vitest";
import { createEnvelope, readEnvelope } from "./envelope.js";

describe("iframe envelope parsing", () => {
  it("accepts a valid iframe envelope marker with app id and channel", () => {
    expect(
      readEnvelope({
        __nexusIframe: true,
        appId: "app",
        channel: "custom",
        payload: { ok: true },
      }),
    ).toEqual({
      __nexusIframe: true,
      appId: "app",
      channel: "custom",
      payload: { ok: true },
    });
  });

  it.each([null, undefined, true, false, 1, "message"])(
    "rejects primitive envelope value %s",
    (value) => {
      expect(readEnvelope(value)).toBeUndefined();
    },
  );

  it("rejects an envelope with the wrong marker", () => {
    expect(
      readEnvelope({ __nexusIframe: false, appId: "app", channel: "custom" }),
    ).toBeUndefined();
  });

  it("rejects an envelope missing app id", () => {
    expect(
      readEnvelope({ __nexusIframe: true, channel: "custom" }),
    ).toBeUndefined();
  });

  it("rejects an envelope missing channel", () => {
    expect(readEnvelope({ __nexusIframe: true, appId: "app" })).toBeUndefined();
  });

  it("rejects an envelope missing payload", () => {
    expect(
      readEnvelope({ __nexusIframe: true, appId: "app", channel: "custom" }),
    ).toBeUndefined();
  });

  it("rejects an envelope with a non-string nonce", () => {
    expect(
      readEnvelope({
        __nexusIframe: true,
        appId: "app",
        channel: "custom",
        nonce: 123,
        payload: null,
      }),
    ).toBeUndefined();
  });

  it("accepts an explicitly undefined payload", () => {
    const envelope = {
      __nexusIframe: true as const,
      appId: "app",
      channel: "custom",
      payload: undefined,
    };

    expect(readEnvelope(envelope)).toStrictEqual(envelope);
  });

  it("preserves the payload reference and extra fields", () => {
    const payload = { nested: true };
    const envelope = {
      __nexusIframe: true,
      appId: "app",
      channel: "custom",
      payload,
      extra: { preserved: true },
    };

    expect(readEnvelope(envelope)).toStrictEqual(envelope);
    expect(readEnvelope(envelope)?.payload).toBe(payload);
    expect(readEnvelope(envelope)?.extra).toBe(envelope.extra);
  });

  it("creates an envelope accepted by the same contract", () => {
    const payload = { nested: true };
    const envelope = createEnvelope("app", "custom", payload, "nonce");

    expect(readEnvelope(envelope)).toStrictEqual(envelope);
    expect(envelope.payload).toBe(payload);
    expect(envelope.nonce).toBe("nonce");
  });

  it("rejects an envelope whose fields throw when read", () => {
    const envelope = {};
    Object.defineProperty(envelope, "__nexusIframe", {
      get() {
        throw new Error("untrusted getter");
      },
    });

    expect(readEnvelope(envelope)).toBeUndefined();
  });
});

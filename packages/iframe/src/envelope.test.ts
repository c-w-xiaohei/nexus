import { describe, expect, it } from "vitest";
import { readEnvelope } from "./envelope";

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
});

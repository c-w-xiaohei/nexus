import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundEndpoint } from "../endpoints/background.js";
import { ContentScriptEndpoint } from "../endpoints/content-script.js";
import { UIClientEndpoint } from "../endpoints/ui-client.js";

function stubRuntime({
  version = "152",
  brand = "Google Chrome",
  manifest = {
    manifest_version: 3,
    message_serialization: "structured_clone",
  } as Record<string, unknown>,
} = {}) {
  vi.stubGlobal("chrome", { runtime: { getManifest: () => manifest } });
  vi.stubGlobal("navigator", {
    userAgentData: {
      brands: [
        { brand: "Not A Brand", version: "99" },
        { brand: "Chromium", version },
        { brand, version },
      ],
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["background", () => new BackgroundEndpoint()],
  ["content script", () => new ContentScriptEndpoint()],
  ["extension page", () => new UIClientEndpoint()],
] as const)("%s binary messaging", (_name, createEndpoint) => {
  it.each(["152", "153", "160"])(
    "enables binary packets on opted-in Chrome %s without enabling transferables",
    (version) => {
      stubRuntime({ version });
      const endpoint = createEndpoint();
      expect(endpoint.config.binaryPackets).toBe(true);
      expect(endpoint.capabilities.supportsTransferables).toBe(false);
    },
  );

  it.each(["148", "151", "", "unknown", "152beta"])(
    "uses JSON/Base64 when the Chrome version is %j",
    (version) => {
      stubRuntime({ version });
      expect(createEndpoint().config.binaryPackets).toBe(false);
    },
  );

  it.each([
    { manifest_version: 3 },
    { manifest_version: 3, message_serialization: "json" },
    { manifest_version: 2, message_serialization: "structured_clone" },
  ])("requires an MV3 Structured Clone opt-in: %j", (manifest) => {
    stubRuntime({ manifest });
    expect(createEndpoint().config.binaryPackets).toBe(false);
  });

  it.each(["Chromium", "Microsoft Edge", "Opera", "Unknown Browser"])(
    "does not assume %s shares Chrome's support baseline",
    (brand) => {
      stubRuntime({ brand });
      expect(createEndpoint().config.binaryPackets).toBe(false);
    },
  );

  it("falls back when User-Agent Client Hints are unavailable, even with a Chrome-like UA", () => {
    stubRuntime();
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0",
    });
    expect(createEndpoint().config.binaryPackets).toBe(false);
  });

  it("falls back when navigator is unavailable", () => {
    stubRuntime();
    vi.stubGlobal("navigator", undefined);
    expect(createEndpoint().config.binaryPackets).toBe(false);
  });

  it("selects the mode at endpoint creation rather than module import", () => {
    stubRuntime({ version: "151" });
    const oldEndpoint = createEndpoint();
    stubRuntime({ version: "152" });
    expect(createEndpoint().config.binaryPackets).toBe(true);
    expect(oldEndpoint.config.binaryPackets).toBe(false);
  });
});

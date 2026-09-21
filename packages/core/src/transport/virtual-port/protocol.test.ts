import { describe, expect, it } from "vitest";
import { VirtualPortProtocol } from "./protocol";

describe("VirtualPortProtocol", () => {
  it("classifies valid protocol messages", () => {
    const message = {
      __nexusVirtualPort: true,
      version: 1,
      type: "data",
      channelId: "channel-1",
      from: "client",
      nonce: "nonce-1",
      seq: 1,
      payload: { hello: "world" },
    };

    const result = VirtualPortProtocol.safeClassify(message);

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toEqual(message);
  });

  it("preserves opaque payload identity during classification", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const result = VirtualPortProtocol.safeClassify({
      __nexusVirtualPort: true,
      version: 1,
      type: "data",
      channelId: "channel-1",
      from: "client",
      nonce: "nonce-1",
      seq: 0,
      payload,
    });

    expect(result.unwrap().payload).toBe(payload);
  });

  it("rejects malformed messages without throwing", () => {
    const result = VirtualPortProtocol.safeClassify({ type: "data" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("VIRTUAL_PORT_PROTOCOL_INVALID");
    }
  });

  it("contains exceptions from hostile message getters", () => {
    const cause = new Error("message-getter-boom");
    const message = {
      __nexusVirtualPort: true,
      version: 1,
      type: "data",
      channelId: "channel-1",
      from: "client",
      nonce: "nonce-1",
      seq: 1,
      payload: null,
    };
    Object.defineProperty(message, "channelId", {
      get: () => {
        throw cause;
      },
    });

    const result = VirtualPortProtocol.safeClassify(message);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("VIRTUAL_PORT_PROTOCOL_INVALID");
      expect(result.error.context).toEqual({ issues: [], cause });
    }
  });

  it("requires data messages to carry a sequence number", () => {
    const result = VirtualPortProtocol.safeClassify({
      __nexusVirtualPort: true,
      version: 1,
      type: "data",
      channelId: "channel-1",
      from: "client",
      nonce: "nonce-1",
      payload: "missing-seq",
    });

    expect(result.isErr()).toBe(true);
  });

  it("rejects metadata on connect and accept messages", () => {
    const connectResult = VirtualPortProtocol.safeClassify({
      __nexusVirtualPort: true,
      version: 1,
      type: "connect",
      channelId: "channel-1",
      from: "client",
      nonce: "nonce-1",
      metadata: { target: "background" },
    });
    const acceptResult = VirtualPortProtocol.safeClassify({
      __nexusVirtualPort: true,
      version: 1,
      type: "accept",
      channelId: "channel-1",
      from: "server",
      nonce: "nonce-1",
      metadata: { platform: "iframe" },
    });

    expect(connectResult.isErr()).toBe(true);
    expect(acceptResult.isErr()).toBe(true);
  });
});

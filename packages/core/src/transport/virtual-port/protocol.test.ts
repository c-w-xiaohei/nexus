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
    expect(result._unsafeUnwrap()).toEqual(message);
  });

  it("rejects malformed messages without throwing", () => {
    const result = VirtualPortProtocol.safeClassify({ type: "data" });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe(
      "VIRTUAL_PORT_PROTOCOL_INVALID",
    );
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

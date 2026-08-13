import { describe, expect, it } from "vitest";
import { BinaryFrame } from "./framing/binary-frame";

const bytes = (...values: number[]) => Uint8Array.from(values).buffer;

const unwrap = <T, E>(result: import("better-result").Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

describe("BinaryFrame", () => {
  it("buffers half packets until a complete frame arrives", () => {
    const decoder = BinaryFrame.createDecoder();
    const encoded = unwrap(BinaryFrame.encode(bytes(1, 2, 3)));

    expect(unwrap(decoder.push(encoded.slice(0, 5)))).toEqual([]);

    const frames = unwrap(decoder.push(encoded.slice(5)));
    expect(new Uint8Array(frames[0])).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("decodes sticky packets as multiple frames", () => {
    const decoder = BinaryFrame.createDecoder();
    const first = new Uint8Array(unwrap(BinaryFrame.encode(bytes(1))));
    const second = new Uint8Array(unwrap(BinaryFrame.encode(bytes(2, 3))));
    const sticky = new Uint8Array(first.byteLength + second.byteLength);
    sticky.set(first, 0);
    sticky.set(second, first.byteLength);

    const frames = unwrap(decoder.push(sticky.buffer));

    expect(frames.map((frame) => Array.from(new Uint8Array(frame)))).toEqual([
      [1],
      [2, 3],
    ]);
  });

  it("rejects invalid or too-large frame lengths", () => {
    const emptyResult = BinaryFrame.encode(new ArrayBuffer(0));
    expect(emptyResult.isErr()).toBe(true);
    if (emptyResult.isErr()) {
      expect(emptyResult.error).toMatchObject({
        code: "E_IPC_PROTOCOL_ERROR",
      });
    }

    const decoder = BinaryFrame.createDecoder({ maxFrameSize: 2 });
    const oversizedHeader = new ArrayBuffer(4);
    new DataView(oversizedHeader).setUint32(0, 3, false);

    const oversizedResult = decoder.push(oversizedHeader);
    expect(oversizedResult.isErr()).toBe(true);
    if (oversizedResult.isErr()) {
      expect(oversizedResult.error).toMatchObject({
        code: "E_IPC_PROTOCOL_ERROR",
      });
    }
  });
});

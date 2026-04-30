import { describe, expect, it } from "vitest";
import { BinaryFrame } from "./framing/binary-frame";

const bytes = (...values: number[]) => Uint8Array.from(values).buffer;

describe("BinaryFrame", () => {
  it("buffers half packets until a complete frame arrives", () => {
    const decoder = BinaryFrame.createDecoder();
    const encoded = BinaryFrame.encode(bytes(1, 2, 3))._unsafeUnwrap();

    expect(decoder.push(encoded.slice(0, 5))._unsafeUnwrap()).toEqual([]);

    const frames = decoder.push(encoded.slice(5))._unsafeUnwrap();
    expect(new Uint8Array(frames[0])).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("decodes sticky packets as multiple frames", () => {
    const decoder = BinaryFrame.createDecoder();
    const first = new Uint8Array(BinaryFrame.encode(bytes(1))._unsafeUnwrap());
    const second = new Uint8Array(
      BinaryFrame.encode(bytes(2, 3))._unsafeUnwrap(),
    );
    const sticky = new Uint8Array(first.byteLength + second.byteLength);
    sticky.set(first, 0);
    sticky.set(second, first.byteLength);

    const frames = decoder.push(sticky.buffer)._unsafeUnwrap();

    expect(frames.map((frame) => Array.from(new Uint8Array(frame)))).toEqual([
      [1],
      [2, 3],
    ]);
  });

  it("rejects invalid or too-large frame lengths", () => {
    expect(BinaryFrame.encode(new ArrayBuffer(0))._unsafeUnwrapErr().code).toBe(
      "E_IPC_PROTOCOL_ERROR",
    );

    const decoder = BinaryFrame.createDecoder({ maxFrameSize: 2 });
    const oversizedHeader = new ArrayBuffer(4);
    new DataView(oversizedHeader).setUint32(0, 3, false);

    expect(decoder.push(oversizedHeader)._unsafeUnwrapErr().code).toBe(
      "E_IPC_PROTOCOL_ERROR",
    );
  });
});

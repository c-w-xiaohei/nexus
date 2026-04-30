import { err, ok, Result } from "neverthrow";
import { NodeIpcError } from "../errors";

type DecoderOptions = {
  maxFrameSize?: number;
};

const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024;
const HEADER_LENGTH = 4;

export namespace BinaryFrame {
  export const encode = (
    packet: ArrayBuffer,
  ): Result<ArrayBuffer, NodeIpcError> => {
    if (packet.byteLength === 0)
      return err(
        new NodeIpcError(
          "Frame length must be greater than zero",
          "E_IPC_PROTOCOL_ERROR",
        ),
      );
    if (packet.byteLength > DEFAULT_MAX_FRAME_SIZE)
      return err(
        new NodeIpcError("Frame is too large", "E_IPC_PROTOCOL_ERROR"),
      );

    const output = new ArrayBuffer(HEADER_LENGTH + packet.byteLength);
    const view = new DataView(output);
    view.setUint32(0, packet.byteLength, false);
    new Uint8Array(output, HEADER_LENGTH).set(new Uint8Array(packet));
    return ok(output);
  };

  export const createDecoder = (options: DecoderOptions = {}) => {
    const maxFrameSize = options.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE;
    let buffer = new Uint8Array(0);

    return {
      push(chunk: ArrayBuffer): Result<ArrayBuffer[], NodeIpcError> {
        const incoming = new Uint8Array(chunk);
        const combined = new Uint8Array(
          buffer.byteLength + incoming.byteLength,
        );
        combined.set(buffer, 0);
        combined.set(incoming, buffer.byteLength);
        buffer = combined;

        const frames: ArrayBuffer[] = [];
        while (buffer.byteLength >= HEADER_LENGTH) {
          const length = new DataView(
            buffer.buffer,
            buffer.byteOffset,
            HEADER_LENGTH,
          ).getUint32(0, false);
          if (length === 0 || length > maxFrameSize) {
            return err(
              new NodeIpcError(
                "Malformed frame length",
                "E_IPC_PROTOCOL_ERROR",
              ),
            );
          }
          if (buffer.byteLength < HEADER_LENGTH + length) break;

          const frame = buffer.slice(HEADER_LENGTH, HEADER_LENGTH + length);
          frames.push(
            frame.buffer.slice(
              frame.byteOffset,
              frame.byteOffset + frame.byteLength,
            ),
          );
          buffer = buffer.slice(HEADER_LENGTH + length);
        }

        return ok(frames);
      },
    };
  };
}

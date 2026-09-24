import { Packr } from "msgpackr";
import { Result } from "better-result";
import { NexusProtocolError } from "../../errors/transport-errors.js";
import type { ISerializer } from "./interface.js";
import { JsonSerializer } from "./json-serializer.js";

const packr = new Packr({ useRecords: false });

/** Benchmark-only alternative using the same validated Nexus packet shape. */
export const benchmarkBinarySerializer: ISerializer = {
  packetType: "arraybuffer",
  safeSerialize: (message) =>
    JsonSerializer.safePack(message).andThen((packet) =>
      Result.try({
        try: () => {
          const bytes = packr.pack(packet);
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
        },
        catch: (error) =>
          new NexusProtocolError("Failed to encode benchmark packet", {
            originalError: error,
          }),
      }),
    ),
  safeDeserialize: (packet) =>
    packet instanceof ArrayBuffer
      ? Result.try({
          try: () => packr.unpack(new Uint8Array(packet)),
          catch: (error) =>
            new NexusProtocolError("Failed to decode benchmark packet", {
              originalError: error,
            }),
        }).andThen(JsonSerializer.safeUnpack)
      : Result.err(
          new NexusProtocolError(
            "Benchmark codec requires an ArrayBuffer packet",
          ),
        ),
};

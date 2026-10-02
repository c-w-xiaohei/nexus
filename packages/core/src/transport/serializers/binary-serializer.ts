import { NexusMessageType, type NexusMessage } from "../../types/message.js";
import type { ISerializer } from "./interface.js";
import { NexusProtocolError } from "../../errors/transport-errors.js";
import { JsonSerializer } from "./json-serializer.js";
import {
  decodeBinaryValues,
  encodeBinaryValues,
  preflightCodecBytes,
  type Attachment,
} from "./binary-values.js";
import type { ByteReservationLease } from "../../service/payload/byte-reservation.js";
import { isBinaryValue } from "../../service/payload/binary-value.js";
import { Result } from "better-result";
const { err, ok } = Result;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PREFIX_BYTES = 4;

export namespace BinarySerializer {
  export const safeSerialize = (
    logicalMessage: NexusMessage,
    options: { readonly lease?: ByteReservationLease } = {},
  ): Result<ArrayBuffer, NexusProtocolError> => {
    const validated = JsonSerializer.safePack(logicalMessage);
    if (validated.isErr()) return err(validated.error);
    try {
      const estimate = preflightCodecBytes(validated.value);
      if (options.lease && !options.lease.reserve(estimate))
        throw new TypeError("Shared transport buffer capacity exceeded.");
      const attachments: Attachment[] = [];
      const transformed = encodeBinaryValues(validated.value, attachments);
      const metadata = encoder.encode(
        JSON.stringify({
          version: 1,
          packet: transformed,
          attachments: attachments.map(({ kind, mimeType, bytes }) => ({
            kind,
            mimeType,
            length: bytes.byteLength,
          })),
        }),
      );
      const total =
        PREFIX_BYTES +
        metadata.byteLength +
        attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0);
      const output = new Uint8Array(total);
      new DataView(output.buffer).setUint32(0, metadata.byteLength, false);
      output.set(metadata, PREFIX_BYTES);
      let offset = PREFIX_BYTES + metadata.byteLength;
      for (const attachment of attachments) {
        output.set(attachment.bytes, offset);
        offset += attachment.bytes.byteLength;
      }
      return ok(output.buffer);
    } catch (error) {
      return err(
        new NexusProtocolError("Failed to binary-serialize packet", {
          messageType: logicalMessage.type,
          originalError: error,
        }),
      );
    }
  };

  export const safeDeserialize = (
    packet: string | ArrayBuffer,
  ): Result<NexusMessage, NexusProtocolError> => {
    if (!(packet instanceof ArrayBuffer))
      return err(
        new NexusProtocolError(
          "BinarySerializer can only process ArrayBuffer packets",
          { packetType: typeof packet },
        ),
      );
    try {
      if (packet.byteLength < PREFIX_BYTES)
        throw new TypeError("Truncated binary packet header.");
      const bytes = new Uint8Array(packet);
      const metadataLength = new DataView(packet).getUint32(0, false);
      if (metadataLength > packet.byteLength - PREFIX_BYTES)
        throw new TypeError("Truncated binary packet metadata.");
      const metadata = JSON.parse(
        decoder.decode(
          bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength),
        ),
      ) as { version?: unknown; packet?: unknown; attachments?: unknown };
      if (metadata.version !== 1 || !Array.isArray(metadata.attachments))
        throw new TypeError("Invalid binary packet metadata.");
      const attachments: (Attachment | undefined)[] = [];
      let offset = PREFIX_BYTES + metadataLength;
      for (const entry of metadata.attachments as Record<string, unknown>[]) {
        if (
          !entry ||
          !["array-buffer", "uint8-array", "blob"].includes(
            String(entry.kind),
          ) ||
          !Number.isSafeInteger(entry.length) ||
          (entry.length as number) < 0 ||
          (entry.mimeType !== undefined && typeof entry.mimeType !== "string")
        )
          throw new TypeError("Invalid binary attachment metadata.");
        const length = entry.length as number;
        if (length > packet.byteLength - offset)
          throw new TypeError("Truncated binary attachment.");
        attachments.push({
          kind: entry.kind as Attachment["kind"],
          mimeType: entry.mimeType as string | undefined,
          bytes: bytes.slice(offset, offset + length),
        });
        offset += length;
      }
      if (offset !== packet.byteLength)
        throw new TypeError("Unexpected trailing bytes in binary packet.");
      const decoded = decodeBinaryValues(metadata.packet, attachments);
      if (attachments.some((attachment) => attachment !== undefined))
        throw new TypeError("Unreferenced binary attachment.");
      if (
        Array.isArray(decoded) &&
        decoded[0] === NexusMessageType.CHUNK_DATA &&
        isBinaryValue(decoded[4])
      )
        decoded[4] = new Uint8Array(decoded[4].bytes);
      return JsonSerializer.safeUnpack(decoded as unknown[]);
    } catch (error) {
      return err(
        new NexusProtocolError("Failed to binary-deserialize packet", {
          packetSize: packet.byteLength,
          originalError: error,
        }),
      );
    }
  };

  export const serializer: ISerializer = {
    packetType: "arraybuffer",
    safeSerialize,
    safeDeserialize,
  };
}

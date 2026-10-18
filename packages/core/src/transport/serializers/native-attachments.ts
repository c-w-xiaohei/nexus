import * as v from "valibot";
import { Result } from "better-result";
import { NexusMessageType, type NexusMessage } from "../../types/message";
import { NexusProtocolError } from "../../errors/transport-errors";
import { JsonSerializer } from "./json-serializer";
import {
  encodeBinaryValues,
  decodeBinaryValues,
  preflightCodecBytes,
} from "./binary-values";
import type { Attachment } from "./binary-values";

const PacketSchema = v.strictObject({
  nexusAttachments: v.literal(1),
  metadata: v.string(),
  buffers: v.pipe(v.array(v.instance(ArrayBuffer)), v.maxLength(100_000)),
});
const DescriptorSchema = v.strictObject({
  kind: v.picklist(["array-buffer", "uint8-array", "blob"]),
  length: v.pipe(v.number(), v.integer(), v.minValue(0)),
  buffer: v.pipe(v.number(), v.integer(), v.minValue(0)),
  mimeType: v.optional(v.string()),
});
const MetadataSchema = v.strictObject({
  packet: v.array(v.unknown()),
  attachments: v.array(DescriptorSchema),
});
export type NativeAttachmentPacket = v.InferOutput<typeof PacketSchema>;

/** The wire contains validated JSON metadata and raw buffers only. No ownership policy crosses it. */
export function nativePacketSize(value: unknown): number {
  const parsed = v.safeParse(PacketSchema, value);
  if (!parsed.success) return Infinity;
  return (
    new TextEncoder().encode(parsed.output.metadata).byteLength +
    parsed.output.buffers.reduce(
      (total, buffer) => total + buffer.byteLength,
      0,
    )
  );
}

/** Reuses the ordinary packet/value codec; undefined selects its existing copy path. */
export function prepareNativePacket(
  message: NexusMessage,
): Result<NativeAttachmentPacket | undefined, NexusProtocolError> {
  return JsonSerializer.safePack(message).andThen((packet) =>
    Result.try({
      try: () => {
        let requiresTransfer = false;
        preflightCodecBytes(packet, (binary) => {
          requiresTransfer ||= binary.transfer;
        });
        if (!requiresTransfer) return undefined;
        const attachments: Attachment[] = [];
        const encoded = encodeBinaryValues(packet, attachments);
        const buffers: ArrayBuffer[] = [];
        const indices = new Map<ArrayBuffer, number>();
        const descriptors = attachments.map(
          ({ kind, mimeType, bytes, transfer }) => {
            // Only complete buffers can be handed to the native transfer list.
            const buffer =
              bytes.byteOffset === 0 &&
              bytes.byteLength === bytes.buffer.byteLength
                ? (bytes.buffer as ArrayBuffer)
                : bytes.slice().buffer;
            if (transfer && buffer !== bytes.buffer)
              throw new TypeError("Transfer attachment must cover its buffer.");
            new Uint8Array(buffer); // Reject detached buffers, including detached empty values.
            let index = indices.get(buffer);
            if (index === undefined) {
              index = buffers.length;
              indices.set(buffer, index);
              buffers.push(buffer);
            }
            return { kind, mimeType, length: bytes.byteLength, buffer: index };
          },
        );
        return {
          nexusAttachments: 1 as const,
          metadata: JSON.stringify({
            packet: encoded,
            attachments: descriptors,
          }),
          buffers,
        };
      },
      catch: (error) =>
        new NexusProtocolError("Invalid native attachment payload", {
          originalError: error,
          transferOutcome: "determinate",
        }),
    }),
  );
}

export function decodeNativePacket(
  value: unknown,
): Result<NexusMessage, NexusProtocolError> {
  return Result.try({
    try: () => {
      const wire = v.parse(PacketSchema, value);
      const metadata = v.parse(MetadataSchema, JSON.parse(wire.metadata));
      preflightCodecBytes(metadata);
      const used = new Set<number>();
      const attachments: (Attachment | undefined)[] = metadata.attachments.map(
        (descriptor) => {
          const buffer = wire.buffers[descriptor.buffer];
          if (
            !buffer ||
            buffer.byteLength !== descriptor.length ||
            (descriptor.kind === "blob" && descriptor.mimeType === undefined)
          )
            throw new TypeError("Invalid native attachment descriptor.");
          used.add(descriptor.buffer);
          return {
            kind: descriptor.kind,
            mimeType: descriptor.mimeType,
            bytes: new Uint8Array(buffer),
          };
        },
      );
      if (used.size !== wire.buffers.length)
        throw new TypeError("Unreferenced native buffer.");
      const packet = decodeBinaryValues(metadata.packet, attachments);
      if (attachments.some(Boolean))
        throw new TypeError("Unreferenced native attachment.");
      return packet;
    },
    catch: (error) =>
      new NexusProtocolError("Invalid native attachment packet", {
        originalError: error,
      }),
  })
    .andThen(JsonSerializer.safeUnpack)
    .andThen((message) =>
      [
        NexusMessageType.APPLY,
        NexusMessageType.SET,
        NexusMessageType.RES,
        NexusMessageType.BATCH,
        NexusMessageType.BATCH_RES,
      ].includes(message.type)
        ? Result.ok(message)
        : Result.err(
            new NexusProtocolError(
              "Native attachments require a data payload.",
            ),
          ),
    );
}

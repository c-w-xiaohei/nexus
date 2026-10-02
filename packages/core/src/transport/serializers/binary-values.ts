import {
  createBinaryValue,
  isBinaryValue,
  type BinaryValue,
} from "../../service/payload/binary-value.js";
import { DEFAULT_TRANSPORT_LIMITS } from "../transport-config.js";

const marker = "\u0000nexus-binary-v1";
const escaped = "\u0000nexus-escaped-object-v1";
const mapMarker = "\u0000nexus-map-v1";
const setMarker = "\u0000nexus-set-v1";
export type Attachment = Pick<BinaryValue, "kind" | "mimeType" | "bytes">;

const MAX_CODEC_DEPTH = 128;
const MAX_CODEC_NODES = 100_000;

/** Check traversal limits and reserve a conservative byte estimate in one pass. */
export function preflightCodecBytes(value: unknown): number {
  const ancestors = new Set<object>();
  const budget = { nodes: 0, bytes: 4 };
  const visit = (item: unknown, depth: number): void => {
    if (depth > MAX_CODEC_DEPTH || ++budget.nodes > MAX_CODEC_NODES)
      throw new TypeError("Serializer traversal limit exceeded.");
    budget.bytes += 32;
    if (typeof item === "string") {
      budget.bytes += item.length * 6;
    } else if (isBinaryValue(item)) {
      budget.bytes +=
        item.bytes.byteLength +
        Math.ceil(item.bytes.byteLength / 3) * 4 +
        (item.mimeType?.length ?? 0) * 6 +
        256;
    } else if (item instanceof ArrayBuffer) {
      budget.bytes +=
        item.byteLength + Math.ceil(item.byteLength / 3) * 4 + 256;
    } else if (ArrayBuffer.isView(item)) {
      budget.bytes +=
        item.byteLength + Math.ceil(item.byteLength / 3) * 4 + 256;
    } else if (item && typeof item === "object") {
      if (ancestors.has(item)) throw new TypeError("Cyclic serializer value.");
      ancestors.add(item);
      if (item instanceof Map) {
        budget.bytes += mapMarker.length * 6 + 16;
        for (const [key, entry] of item) {
          visit(key, depth + 1);
          visit(entry, depth + 1);
        }
      } else if (item instanceof Set) {
        budget.bytes += setMarker.length * 6 + 16;
        for (const entry of item) visit(entry, depth + 1);
      } else if (Array.isArray(item)) {
        for (const entry of item) visit(entry, depth + 1);
      } else {
        for (const [key, entry] of Object.entries(item)) {
          budget.bytes += key.length * 6;
          visit(entry, depth + 1);
        }
      }
      ancestors.delete(item);
    } else {
      budget.bytes += 16;
    }
    if (budget.bytes > DEFAULT_TRANSPORT_LIMITS.maxMessageBytes)
      throw new TypeError("Serializer output budget exceeded.");
  };
  visit(value, 0);
  return budget.bytes;
}

export function encodeJsonValues(value: unknown): unknown {
  return encodeValues(value, (binary) => ({
    [marker]: binary.kind,
    mimeType: binary.mimeType,
    data: toBase64(binary.bytes),
  }));
}

export function decodeJsonValues(value: unknown): unknown {
  return decodeValues(value, (record) => {
    if (
      Object.keys(record).some(
        (key) => ![marker, "mimeType", "data"].includes(key),
      ) ||
      typeof record.data !== "string"
    )
      throw new TypeError("Invalid binary marker.");
    const kind = record[marker];
    if (kind !== "array-buffer" && kind !== "uint8-array" && kind !== "blob")
      throw new TypeError("Invalid binary marker kind.");
    if (record.mimeType !== undefined && typeof record.mimeType !== "string")
      throw new TypeError("Invalid binary MIME type.");
    if (kind === "blob" && typeof record.mimeType !== "string")
      throw new TypeError("Blob marker requires a MIME type.");
    return createBinaryValue(
      kind,
      fromBase64(record.data),
      record.mimeType as string | undefined,
    );
  });
}

export function encodeBinaryValues(
  value: unknown,
  attachments: Attachment[],
): unknown {
  return encodeValues(value, (binary) => {
    const index = attachments.length;
    attachments.push({
      kind: binary.kind,
      mimeType: binary.mimeType,
      bytes: binary.bytes,
    });
    return { [marker]: index, length: binary.bytes.byteLength };
  });
}

function normalizeBinaryValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer)
    return createBinaryValue("array-buffer", new Uint8Array(value.slice(0)));
  if (value instanceof Uint8Array)
    return createBinaryValue("uint8-array", new Uint8Array(value));
  return value;
}

function encodeValues(
  value: unknown,
  encodeBinary: (binary: BinaryValue) => unknown,
): unknown {
  value = normalizeBinaryValue(value);
  if (isBinaryValue(value)) return encodeBinary(value);
  if (value instanceof Map)
    return {
      [mapMarker]: [...value].map(([key, item]) => [
        encodeValues(key, encodeBinary),
        encodeValues(item, encodeBinary),
      ]),
    };
  if (value instanceof Set)
    return {
      [setMarker]: [...value].map((item) => encodeValues(item, encodeBinary)),
    };
  if (Array.isArray(value))
    return value.map((item) => encodeValues(item, encodeBinary));
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [
      key,
      encodeValues(item, encodeBinary),
    ]);
    const object = Object.fromEntries(entries);
    return [marker, escaped, mapMarker, setMarker].some((key) =>
      Object.hasOwn(object, key),
    )
      ? { [escaped]: entries }
      : object;
  }
  return value;
}

function decodeValues(
  value: unknown,
  decodeBinary: (record: Record<string, unknown>) => BinaryValue,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => decodeValues(item, decodeBinary));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && Array.isArray(record[mapMarker]))
    return new Map(
      (record[mapMarker] as [unknown, unknown][]).map(([key, item]) => [
        decodeValues(key, decodeBinary),
        decodeValues(item, decodeBinary),
      ]),
    );
  if (Object.keys(record).length === 1 && Array.isArray(record[setMarker]))
    return new Set(
      (record[setMarker] as unknown[]).map((item) =>
        decodeValues(item, decodeBinary),
      ),
    );
  if (Object.keys(record).length === 1 && Array.isArray(record[escaped]))
    return Object.fromEntries(
      (record[escaped] as [string, unknown][]).map(([key, item]) => [
        key,
        decodeValues(item, decodeBinary),
      ]),
    );
  if (Object.hasOwn(record, marker)) return decodeBinary(record);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      decodeValues(item, decodeBinary),
    ]),
  );
}

export function decodeBinaryValues(
  value: unknown,
  attachments: (Attachment | undefined)[],
): unknown {
  return decodeValues(value, (record) => {
    if (
      Object.keys(record).length !== 2 ||
      !Number.isSafeInteger(record[marker]) ||
      !Number.isSafeInteger(record.length)
    )
      throw new TypeError("Invalid binary attachment reference.");
    const index = record[marker] as number;
    const attachment = attachments[index];
    if (!attachment || attachment.bytes.byteLength !== record.length)
      throw new TypeError("Invalid binary attachment length or reference.");
    attachments[index] = undefined;
    return createBinaryValue(
      attachment.kind,
      attachment.bytes,
      attachment.mimeType,
    );
  });
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new TypeError("Invalid Base64 binary value.");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

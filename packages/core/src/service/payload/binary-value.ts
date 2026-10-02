const binaryValueBrand: unique symbol = Symbol("NexusBinaryValue");

/** Internal, codec-only representation of a finite binary RPC value. */
export type BinaryValue = {
  readonly [binaryValueBrand]: true;
  readonly kind: "array-buffer" | "uint8-array" | "blob";
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
};

export function createBinaryValue(
  kind: BinaryValue["kind"],
  bytes: Uint8Array,
  mimeType?: string,
): BinaryValue {
  return Object.freeze({
    [binaryValueBrand]: true as const,
    kind,
    bytes,
    ...(mimeType === undefined ? {} : { mimeType }),
  });
}

export function isBinaryValue(value: unknown): value is BinaryValue {
  return (
    value !== null &&
    typeof value === "object" &&
    binaryValueBrand in value &&
    (value as BinaryValue)[binaryValueBrand] === true
  );
}

export function decodeBinaryValue(value: BinaryValue): unknown {
  switch (value.kind) {
    case "array-buffer":
      return value.bytes.slice().buffer;
    case "uint8-array":
      return value.bytes.slice();
    case "blob":
      if (typeof Blob === "undefined")
        throw new TypeError("Blob is unavailable in the receiving runtime.");
      return new Blob([value.bytes.slice().buffer as ArrayBuffer], {
        type: value.mimeType,
      });
  }
}

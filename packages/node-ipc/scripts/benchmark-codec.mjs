import { benchmarkBinarySerializer } from "@nexus-js/core/internal/serializer-benchmark";
import { Transport } from "@nexus-js/core/transport";

const codec = process.env.NEXUS_BENCH_CODEC ?? "nexus-binary";
if (codec !== "nexus-binary" && codec !== "msgpackr")
  throw new Error(`Unknown benchmark codec: ${codec}`);

let selected = false;
if (codec === "msgpackr") {
  const create = Transport.create;
  Transport.create = (endpoint) => {
    if (!endpoint.capabilities?.binaryPackets)
      throw new Error("Benchmark codec requires a binary endpoint");
    selected = true;
    return {
      ...create(endpoint),
      serializer: benchmarkBinarySerializer,
      binarySerializer: benchmarkBinarySerializer,
    };
  };
}

function verifyCodec() {
  if (codec === "msgpackr" && !selected)
    throw new Error("Benchmark codec was not installed in Nexus transport");
}

export { codec, verifyCodec };

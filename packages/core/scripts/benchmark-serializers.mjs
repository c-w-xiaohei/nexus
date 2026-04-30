import {
  buildSerializerBenchmarkSummary,
  runSerializerBenchmark,
} from "../dist/internal/serializer-benchmark.mjs";

const iterations = Number.parseInt(
  process.env.NEXUS_SERIALIZER_BENCH_ITERATIONS ?? "10000",
  10,
);
const results = runSerializerBenchmark({
  iterations:
    Number.isFinite(iterations) && iterations > 0 ? iterations : 10000,
});
const summary = buildSerializerBenchmarkSummary(results);

console.table(
  results.map((result) => ({
    serializer: result.serializer,
    case: result.caseName,
    bytes: result.encodedBytes,
    encodeMs: result.encodeMs.toFixed(3),
    decodeMs: result.decodeMs.toFixed(3),
    roundtripMs: result.roundtripMs.toFixed(3),
    serializeOpsPerSec: result.serializeOpsPerSec.toFixed(0),
    deserializeOpsPerSec: result.deserializeOpsPerSec.toFixed(0),
    roundtripOpsPerSec: result.roundtripOpsPerSec.toFixed(0),
    memory: result.memoryAllocationTrend,
  })),
);
console.log(`Node: ${summary.nodeVersion}`);
console.log(`Browser bundle size: ${summary.browserBundleSizeNote}`);
console.log(`CSP impact: ${summary.cspImpact}`);

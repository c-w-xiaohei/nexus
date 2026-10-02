import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pairs = Number(process.env.NEXUS_BENCH_PAIRS ?? 3);
if (!Number.isSafeInteger(pairs) || pairs < 1)
  throw new Error("NEXUS_BENCH_PAIRS must be a positive integer");

const results = new Map();
for (let pair = 0; pair < pairs; pair++) {
  // Reverse the order each pair to reduce effects from CPU temperature and load.
  for (const codec of pair % 2
    ? ["msgpackr", "nexus-binary"]
    : ["nexus-binary", "msgpackr"]) {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./benchmark-rpc.mjs", import.meta.url))],
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, NEXUS_BENCH_CODEC: codec },
      },
    );
    if (child.status !== 0)
      throw new Error(
        `${codec} run failed: ${child.error ?? child.stderr}\n${child.stdout}`,
      );
    const [environment, ...measurements] = child.stdout
      .trim()
      .split("\n")
      .map(JSON.parse);
    if (
      measurements.length !== 9 ||
      measurements.some((m) => m.codec !== codec)
    )
      throw new Error(`Incomplete ${codec} run`);
    if (pair === 0 && codec === "nexus-binary") {
      const { codec: _codec, ...machine } = environment;
      console.log(JSON.stringify({ environment: machine, pairs }));
    }
    for (const measurement of measurements) {
      const key = `${measurement.case}/${measurement.concurrency}`;
      const group = results.get(key) ?? { "nexus-binary": [], msgpackr: [] };
      group[codec].push(measurement);
      results.set(key, group);
    }
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
console.table(
  [...results].map(([scenario, group]) => {
    const baseline = median(group["nexus-binary"].map((m) => m.rpcPerSec));
    const alternative = median(group.msgpackr.map((m) => m.rpcPerSec));
    const pairedChanges = group.msgpackr.map(
      (measurement, index) =>
        (measurement.rpcPerSec / group["nexus-binary"][index].rpcPerSec - 1) *
        100,
    );
    return {
      scenario,
      nexusRpcPerSec: baseline,
      msgpackrRpcPerSec: alternative,
      pairedChangeMedian: `${median(pairedChanges).toFixed(1)}%`,
      pairedChangeRange: `${Math.min(...pairedChanges).toFixed(1)}%..${Math.max(...pairedChanges).toFixed(1)}%`,
      nexusP99Ms: +median(group["nexus-binary"].map((m) => m.p99Ms)).toFixed(3),
      msgpackrP99Ms: +median(group.msgpackr.map((m) => m.p99Ms)).toFixed(3),
    };
  }),
);

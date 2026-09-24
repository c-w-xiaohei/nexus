import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createHistogram, performance } from "node:perf_hooks";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { Nexus, Token } from "@nexus-js/core";
import { usingNodeIpcClient } from "../dist/index.mjs";
import { codec, verifyCodec } from "./benchmark-codec.mjs";

const seconds = Number(process.env.NEXUS_BENCH_SECONDS ?? 5);
const warmupSeconds = Number(process.env.NEXUS_BENCH_WARMUP_SECONDS ?? 1);
if (
  ![seconds, warmupSeconds].every(Number.isFinite) ||
  seconds <= 0 ||
  warmupSeconds < 0
)
  throw new Error(
    "NEXUS_BENCH_SECONDS must be > 0 and NEXUS_BENCH_WARMUP_SECONDS >= 0",
  );

const token = new Token("bench:node-ipc-echo");
const root = await mkdtemp(join(tmpdir(), "nexus-bench-"));
let server;
let connection;
let clientConfig;

try {
  const address = { kind: "path", path: join(root, "daemon.sock") };
  clientConfig = usingNodeIpcClient({
    appId: "nexus-bench-client",
    resolveAddress: () => address,
    configure: false,
  });
  const client = new Nexus().configure(clientConfig);
  server = fork(new URL("./benchmark-rpc-server.mjs", import.meta.url), [
    address.path,
  ]);
  await waitForServer(server);
  await client.ready();
  verifyCodec();
  connection = await client.connect({
    target: {
      context: "node-ipc-daemon",
      appId: "nexus-bench",
      instance: "default",
    },
  });
  const service = connection.get(token);
  console.log(
    JSON.stringify({
      codec,
      node: process.version,
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      warmupSeconds,
      measurementSeconds: seconds,
    }),
  );

  for (const [name, payload] of [
    ["small", "ping"],
    ["text-64k", "x".repeat(64 * 1024)],
    [
      "object-128",
      {
        items: Array.from({ length: 128 }, (_, id) => ({
          id,
          value: `value-${id}`,
          tags: ["alpha", "beta"],
        })),
      },
    ],
  ]) {
    const preflight = await service.echo(payload);
    if (JSON.stringify(preflight) !== JSON.stringify(payload))
      throw new Error(`Echo preflight mismatch for ${name}`);
    for (const concurrency of [1, 8, 32]) {
      const warmupDeadline = performance.now() + warmupSeconds * 1_000;
      await run(warmupDeadline, concurrency, service, payload);
      const start = performance.now();
      const stats = await run(
        start + seconds * 1_000,
        concurrency,
        service,
        payload,
      );
      const elapsedSeconds = (performance.now() - start) / 1_000;
      if (stats.count === 0)
        throw new Error(
          `No RPCs completed for ${name} at concurrency ${concurrency}`,
        );
      console.log(
        JSON.stringify({
          route: "node-ipc",
          codec,
          case: name,
          concurrency,
          rpcPerSec: Math.round(stats.count / elapsedSeconds),
          p99Ms: +(stats.percentile(99) / 1e6).toFixed(3),
        }),
      );
    }
  }
} finally {
  try {
    connection?.disconnect();
    clientConfig?.endpoint.implementation.close?.();
  } finally {
    try {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill();
        const timeout = setTimeout(() => server.kill("SIGKILL"), 5_000);
        try {
          await exited;
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => settle(new Error("Benchmark server startup timed out")),
      10_000,
    );
    const onMessage = (message) =>
      settle(
        message === "ready"
          ? null
          : new Error(`Unexpected server response: ${message}`),
      );
    const onExit = (code) =>
      settle(new Error(`Benchmark server exited before ready: ${code}`));
    const onError = (error) => settle(error);
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.on("error", onError);
    function settle(error) {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      // Keep the error listener until process exit: a late spawn error must not
      // become an unhandled EventEmitter error during cleanup.
      if (error) reject(error);
      else resolve();
    }
  });
}

async function run(deadline, concurrency, service, payload) {
  const latencies = createHistogram();
  let failure;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!failure && performance.now() < deadline) {
        const start = performance.now();
        try {
          const result = await service.echo(payload);
          if (
            typeof payload === "string"
              ? result !== payload
              : result?.items?.length !== payload.items.length ||
                result.items[127]?.value !== payload.items[127].value
          )
            throw new Error("Echo result mismatch");
          latencies.record(
            Math.max(1, Math.round((performance.now() - start) * 1e6)),
          );
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure) throw failure;
  return latencies;
}

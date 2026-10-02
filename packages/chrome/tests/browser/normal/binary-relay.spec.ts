import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { expect, test } from "../harness/playwright-fixtures";
import { fixtureOrigins } from "../harness/targets";
import type { DiagnosticEvent } from "../protocol";

let binaryServer: ChildProcess;
test.beforeAll(async () => {
  binaryServer = spawn(
    process.execPath,
    [resolve("tests/browser/binary-ws-server.mjs")],
    { stdio: "inherit" },
  );
  await expect
    .poll(
      async () => {
        if (binaryServer.exitCode !== null)
          throw new Error(`Binary WS fixture exited: ${binaryServer.exitCode}`);
        try {
          return (await fetch("http://127.0.0.1:4176")).ok;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});
test.afterAll(async () => {
  if (binaryServer.exitCode !== null) return;
  binaryServer.kill("SIGTERM");
  await once(binaryServer, "exit");
});

test.afterEach(async () => {
  await requestServer("/release-holds").catch(() => undefined);
});

test("I01 relays a chunked WebSocket image through MV3 background to content", async ({
  dispatchHostCommandAndResult,
  diagnostics,
  hostPage,
  waitForEvent,
}) => {
  const runId = "binary-relay-image";
  await resetServerStats();
  await startFixture(hostPage, runId, waitForEvent);
  const result = await dispatchHostCommandAndResult(
    hostPage,
    runId,
    "binary-image",
    { expectedParticipant: "content:main" },
  );
  if (result.kind === "error")
    throw new Error(`I01 content call failed: ${result.value}`);
  const image = JSON.parse(result.value) as Record<string, unknown>;
  expect(image).toMatchObject({
    mimeType: "image/png",
    width: 320,
    height: 180,
    decoded: true,
  });
  expect(image.byteLength).toBeGreaterThan(64 * 1024);
  const stats = await serverStats();
  expect(image.sha256).toBe(stats.imageSha256);
  expect(stats).toMatchObject({ imageInvocationCount: 1 });
  expect(stats.binaryMessageCount).toBeGreaterThan(0);
  expect(stats.outboundBinaryMessageCount).toBeGreaterThan(0);
  expect(stats.imageResponseBinaryBytes).toBeGreaterThan(
    image.byteLength as number,
  );
  expect(
    (await diagnostics(runId)).some((event) => event.kind === "error"),
  ).toBe(false);
});

test("I02 sends Blob and File bytes through Relay and returns callback results", async ({
  dispatchHostCommandAndResult,
  hostPage,
  waitForEvent,
}) => {
  const runId = "binary-relay-upload";
  await resetServerStats();
  await startFixture(hostPage, runId, waitForEvent);
  const result = await dispatchHostCommandAndResult(
    hostPage,
    runId,
    "binary-upload",
    { expectedParticipant: "content:main" },
  );
  if (result.kind === "error")
    throw new Error(`I02 content call failed: ${result.value}`);
  expect(JSON.parse(result.value)).toEqual({
    blobSha256: uploadHash(),
    fileSha256: uploadHash(),
    blobMimeType: "application/octet-stream",
    fileMimeType: "application/x-nexus-fixture",
    blobCallback: `callback:blob:${uploadHash()}`,
    fileCallback: `callback:file:${uploadHash()}`,
  });
  expect(await serverStats()).toMatchObject({ uploadCount: 2 });
});

test("I03 terminates an in-flight Relay call with the worker and uses a fresh session", async ({
  controller,
  dispatchHostCommandAndResult,
  extensionId,
  hostPage,
  waitForEvent,
}) => {
  const runId = "binary-relay-worker-termination";
  await resetServerStats();
  await startFixture(hostPage, runId, waitForEvent);
  const pending = dispatchHostCommandAndResult(hostPage, runId, "binary-hold", {
    expectedParticipant: "content:main",
  });
  await waitForEvent(runId, (event) => isBarrier(event, "binary-hold-started"));
  await expect
    .poll(async () => (await serverStats()).holdInvocationCount)
    .toBe(1);
  const workerTarget = await controller.capture(extensionId);
  await controller.closeAfterPending(workerTarget);
  const terminal = await pending;
  expect(terminal.kind).toBe("error");
  expect(JSON.parse(terminal.value)).toMatchObject({
    code: expect.stringMatching(/^E_/),
  });
  await expect
    .poll(async () => (await serverStats()).activeWebSocketCount)
    .toBe(0);
  const wake = await dispatchHostCommandAndResult(
    hostPage,
    runId,
    "background-summary",
    { expectedParticipant: "content:main" },
  );
  if (wake.kind === "error")
    throw new Error(`Replacement worker wake failed: ${wake.value}`);
  const fresh = await dispatchHostCommandAndResult(
    hostPage,
    runId,
    "binary-image",
    { expectedParticipant: "content:main" },
  );
  if (fresh.kind === "error")
    throw new Error(`Fresh I03 call failed: ${fresh.value}`);
  const freshImage = JSON.parse(fresh.value) as { sha256: string };
  const stats = await serverStats();
  expect(freshImage.sha256).toBe(stats.imageSha256);
  expect(stats.imageInvocationCount).toBeGreaterThan(0);
  expect(stats.webSocketConnectionCount).toBe(2);
  expect(stats.holdInvocationCount).toBe(1);
  expect(stats.holdResolvedCount).toBe(0);
  await requestServer("/release-holds", { method: "POST" });
  await expect
    .poll(async () => (await serverStats()).holdResolvedCount)
    .toBe(1);
});

async function startFixture(
  hostPage: import("@playwright/test").Page,
  runId: string,
  waitForEvent: (
    runId: string,
    predicate: (event: DiagnosticEvent) => boolean,
    options?: { readonly after?: ReadonlySet<string>; readonly count?: number },
  ) => Promise<readonly DiagnosticEvent[]>,
): Promise<void> {
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  await waitForEvent(runId, (event) => isBarrier(event, "background-ready"));
  await waitForEvent(runId, (event) =>
    isBarrier(event, "content-listener-ready without route"),
  );
}

type ServerStats = {
  imageInvocationCount: number;
  uploadCount: number;
  binaryMessageCount: number;
  outboundBinaryMessageCount: number;
  imageResponseBinaryBytes: number;
  webSocketConnectionCount: number;
  activeWebSocketCount: number;
  holdInvocationCount: number;
  holdResolvedCount: number;
  imageSha256: string;
};

async function serverStats(): Promise<ServerStats> {
  const response = await fetch("http://127.0.0.1:4176/stats");
  if (!response.ok) throw new Error(`WS stats returned ${response.status}`);
  return (await response.json()) as ServerStats;
}

async function resetServerStats(): Promise<void> {
  await requestServer("/reset", { method: "POST" });
}

async function requestServer(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(`http://127.0.0.1:4176${path}`, init);
  if (!response.ok)
    throw new Error(`WS server ${path} returned ${response.status}`);
  return response;
}

function uploadHash(): string {
  return createHash("sha256")
    .update(Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251))
    .digest("hex");
}

function isBarrier(event: DiagnosticEvent, name: string): boolean {
  return event.kind === "barrier" && event.name === name;
}

import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import {
  parseBridgeResult,
  type BridgeResult,
  type DiagnosticEvent,
} from "../protocol";
import { sanitizeFixtureText } from "../extension/shared/runtime";
import {
  BarrierTimeoutError,
  waitForBarrier as waitForDiagnosticBarrier,
} from "./barriers";
import { Diagnostics } from "./diagnostics";
import { launchExtension, type ExtensionLaunch } from "./launch-extension";
import { ServiceWorkerController } from "./service-worker-controller";

type ResultEvent = DiagnosticEvent & {
  readonly kind: "result";
  readonly value: string;
};
export type BridgeResultExpectation = {
  readonly runId: string;
  readonly command: string;
  readonly sequence: number;
  readonly participant: string;
  readonly sessionId?: string;
};
export type BridgeResultWaitOptions = {
  readonly valueMatches?: (value: string) => boolean;
};
const commandSequences = new WeakMap<Page, number>();
export type DiagnosticCursor = ReadonlySet<string>;
export type DispatchCursor = DiagnosticCursor & {
  readonly commandSequence: number;
};
type Fixture = {
  readonly launch: ExtensionLaunch;
  readonly extensionId: string;
  readonly hostPage: Page;
  readonly controller: ServiceWorkerController;
  readonly diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>;
  readonly waitForBarrier: (
    runId: string,
    name: string,
    occurrence?: number,
  ) => Promise<void>;
  readonly openExtensionPage: (
    entrypoint: "popup" | "options" | "workspace",
    runId: string,
    query?: Readonly<Record<string, string>>,
  ) => Promise<Page>;
  readonly dispatchHostCommand: (
    page: Page,
    runId: string,
    command: string,
    options?: {
      readonly sessionId?: string;
      readonly after?: DiagnosticCursor;
    },
  ) => Promise<DispatchCursor>;
  readonly dispatchHostCommandAndResult: (
    page: Page,
    runId: string,
    command: string,
    options?: {
      readonly sessionId?: string;
      readonly expectedParticipant?: string;
      readonly expectedSessionId?: string;
    },
  ) => Promise<BridgeResult>;
  readonly waitForDomValue: (
    page: Page,
    selector: string,
    before: string | null,
  ) => Promise<string>;
  readonly waitForEvent: (
    runId: string,
    predicate: (event: DiagnosticEvent) => boolean,
    options?: { readonly after?: DiagnosticCursor; readonly count?: number },
  ) => Promise<readonly DiagnosticEvent[]>;
  readonly waitForResult: (
    runId: string,
    predicate: (event: ResultEvent) => boolean,
    options?: { readonly after?: DiagnosticCursor },
  ) => Promise<ResultEvent>;
};

export const test = base.extend<Fixture>({
  launch: [
    async ({}, use, testInfo) => {
      const launch = await launchExtension();
      const consoleLines: string[] = [];
      const pageErrors: string[] = [];
      const pages = new Set<Page>();
      const observe = (page: Page) => {
        pages.add(page);
        page.on("console", (message) =>
          consoleLines.push(sanitizeArtifactText(message.text())),
        );
        page.on("pageerror", (error) =>
          pageErrors.push(sanitizeArtifactError(error)),
        );
      };
      try {
        launch.context.pages().forEach(observe);
        launch.context.on("page", observe);
        await launch.context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
        await use(launch);
      } finally {
        const cleanupErrors: string[] = [];
        const cleanupStages: string[] = [];
        const bodyFailed = testInfo.status !== testInfo.expectedStatus;
        let artifactsCollected = false;
        if (bodyFailed) {
          await collectFailureArtifacts({
            launch,
            testInfo,
            pages,
            consoleLines,
            pageErrors,
            cleanupErrors,
          });
          artifactsCollected = true;
        } else {
          // Keep tracing active until storage cleanup succeeds so cleanup-only
          // failures can retain the same complete bundle as body failures.
        }
        await cleanupStage(
          cleanupStages,
          cleanupErrors,
          "clear-storage",
          () => clearFixtureStorage(launch.context, launch.extensionId),
          false,
        );
        if (cleanupErrors.length > 0 && !artifactsCollected) {
          await collectFailureArtifacts({
            launch,
            testInfo,
            pages,
            consoleLines,
            pageErrors,
            cleanupErrors,
          });
          artifactsCollected = true;
        }
        if (!artifactsCollected) {
          await cleanupStage(cleanupStages, cleanupErrors, "stop-trace", () =>
            launch.context.tracing.stop(),
          );
        }
        await cleanupStage(cleanupStages, cleanupErrors, "close-context", () =>
          launch.context.close(),
        );
        await cleanupStage(cleanupStages, cleanupErrors, "remove-profile", () =>
          rm(launch.userDataDir, { recursive: true, force: true }),
        );
        if (cleanupErrors.length > 0) {
          const cleanupLog = testInfo.outputPath("cleanup-errors.log");
          await attempt(cleanupErrors, () =>
            writeFile(
              cleanupLog,
              sanitizeArtifactText(
                [...cleanupStages, ...cleanupErrors].join("\n"),
              ),
            ),
          );
          await attempt(cleanupErrors, () =>
            testInfo.attach("cleanup-errors.log", {
              path: cleanupLog,
              contentType: "text/plain",
            }),
          );
          if (!bodyFailed)
            throw new Error(
              `Fixture cleanup failed:\n${cleanupErrors.join("\n")}`,
            );
        }
      }
    },
    { timeout: 45_000 },
  ],
  extensionId: async ({ launch }, use) => use(launch.extensionId),
  hostPage: async ({ launch }, use) => use(await launch.context.newPage()),
  controller: async ({ launch }, use) =>
    use(new ServiceWorkerController(launch.context)),
  diagnostics: async ({ launch }, use) =>
    use(async (runId) => readRunDiagnostics(launch.context, runId)),
  waitForBarrier: async ({ diagnostics }, use) =>
    use((runId, name, occurrence = 1) =>
      waitForDiagnosticBarrier({
        name,
        timeoutMs: 5_000,
        readEvents: async () => {
          const events = await diagnostics(runId);
          return events.filter(
            (event) => event.kind === "barrier" && event.name === name,
          ).length >= occurrence
            ? [name]
            : events
                .filter((event) => event.kind === "barrier")
                .map((event) => event.name ?? "");
        },
      }),
    ),
  openExtensionPage: async ({ launch }, use) =>
    use(async (entrypoint, runId, query = {}) => {
      assertRunId(runId);
      const search = new URLSearchParams({ runId, ...query });
      const page = await launch.context.newPage();
      await page.goto(
        `chrome-extension://${launch.extensionId}/${entrypoint}.html?${search}`,
      );
      await expect(page.locator("[data-status]")).toContainText(
        `${entrypoint}:ready:`,
      );
      return page;
    }),
  dispatchHostCommand: async ({ diagnostics }, use) => {
    await use(async (page, runId, command, options = {}) => {
      assertRunId(runId);
      const cursor =
        options.after ?? selectDispatchCursor(await diagnostics(runId));
      const commandSequence = await dispatchBridgeCommand(
        page,
        runId,
        command,
        options.sessionId,
      );
      return Object.assign(new Set(cursor), { commandSequence });
    });
  },
  dispatchHostCommandAndResult: async ({}, use) =>
    use(async (page, runId, command, options = {}) => {
      assertRunId(runId);
      const sequence = await dispatchBridgeCommand(
        page,
        runId,
        command,
        options.sessionId,
      );
      const expected = {
        runId,
        command,
        sequence,
        participant: options.expectedParticipant ?? "content:main",
        ...(options.expectedSessionId === undefined
          ? {}
          : { sessionId: options.expectedSessionId }),
      };
      const value = await waitForHostBridgeResult(page, expected);
      const result = parseBridgeResult(value, expected);
      if (result) return result;
      throw new Error(`Invalid DOM command result: ${value}`);
    }),
  waitForDomValue: async ({}, use) =>
    use((page, selector, before) =>
      waitForChangedDomValue(page, selector, before),
    ),
  waitForEvent: async ({ diagnostics }, use) =>
    use(async (runId, predicate, options = {}) => {
      assertRunId(runId);
      const count = options.count ?? 1;
      const result = await pollUntil(
        async () =>
          (await diagnostics(runId)).filter(
            (event) =>
              !options.after?.has(diagnosticEventIdentity(event)) &&
              predicate(event),
          ),
        (events) => events.length >= count,
      );
      if (result.matched) return result.value;
      throw new BarrierTimeoutError(
        "diagnostic event",
        result.value.map((event) => JSON.stringify(event)),
      );
    }),
  waitForResult: async ({ waitForEvent }, use) =>
    use(async (runId, predicate, options = {}) => {
      const events = await waitForEvent(
        runId,
        (event) => isResultEvent(event) && predicate(event),
        options,
      );
      return events[0] as ResultEvent;
    }),
});

async function collectFailureArtifacts({
  launch,
  testInfo,
  pages,
  consoleLines,
  pageErrors,
  cleanupErrors,
}: {
  readonly launch: ExtensionLaunch;
  readonly testInfo: TestInfo;
  readonly pages: ReadonlySet<Page>;
  readonly consoleLines: readonly string[];
  readonly pageErrors: readonly string[];
  readonly cleanupErrors: string[];
}): Promise<void> {
  const page = [...pages].reverse().find((candidate) => !candidate.isClosed());
  if (page) {
    const screenshot = testInfo.outputPath("failure.png");
    await attempt(cleanupErrors, async () => {
      await page.screenshot({ path: screenshot });
      await testInfo.attach("failure.png", {
        path: screenshot,
        contentType: "image/png",
      });
    });
  }
  const trace = testInfo.outputPath("trace.zip");
  await attempt(cleanupErrors, () =>
    launch.context.tracing.stop({ path: trace }),
  );
  await attempt(cleanupErrors, () =>
    testInfo.attach("trace.zip", {
      path: trace,
      contentType: "application/zip",
    }),
  );
  await writeAndAttachTextArtifact(
    testInfo,
    cleanupErrors,
    "console.log",
    consoleLines.join("\n"),
  );
  await writeAndAttachTextArtifact(
    testInfo,
    cleanupErrors,
    "pageerrors.log",
    pageErrors.join("\n"),
  );
  try {
    await writeAndAttachTextArtifact(
      testInfo,
      cleanupErrors,
      "diagnostics.ndjson",
      await withinCleanupTimeout(diagnosticNdjson(launch.context)),
      "application/x-ndjson",
    );
  } catch (error) {
    const message = sanitizeArtifactError(error);
    cleanupErrors.push(message);
    await writeAndAttachTextArtifact(
      testInfo,
      cleanupErrors,
      "diagnostic-read-error.log",
      message,
    );
  }
}

async function writeAndAttachTextArtifact(
  testInfo: TestInfo,
  errors: string[],
  name: string,
  body: string,
  contentType = "text/plain",
): Promise<void> {
  const path = testInfo.outputPath(name);
  await attempt(errors, () => writeFile(path, sanitizeArtifactText(body)));
  await attempt(errors, () => testInfo.attach(name, { path, contentType }));
}

async function readDiagnostics(
  context: BrowserContext,
): Promise<DiagnosticEvent[]> {
  for (const page of [...context.pages()].reverse()) {
    if (!page.url().startsWith("chrome-extension://")) continue;
    try {
      return await readDiagnosticStorage(page);
    } catch (error) {
      if (!isUnavailableCleanupTarget(error)) throw error;
    }
  }
  for (const worker of [...context.serviceWorkers()].reverse()) {
    try {
      return await readDiagnosticStorage(worker);
    } catch (error) {
      if (!isUnavailableCleanupTarget(error)) throw error;
    }
  }
  return [];
}

async function diagnosticNdjson(context: BrowserContext): Promise<string> {
  const events = await readDiagnostics(context);
  Diagnostics.validate(events);
  return Diagnostics.sort(events)
    .map((event) => JSON.stringify(event))
    .join("\n");
}

async function clearFixtureStorage(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  for (const page of [...context.pages()].reverse()) {
    if (!page.url().startsWith("chrome-extension://")) continue;
    try {
      await clearStorage(page);
      return;
    } catch (error) {
      if (!isUnavailableCleanupTarget(error)) throw error;
    }
  }
  for (const worker of [...context.serviceWorkers()].reverse()) {
    try {
      await clearStorage(worker);
      return;
    } catch (error) {
      if (!isUnavailableCleanupTarget(error)) throw error;
    }
  }
  if (context.pages().some((page) => !page.isClosed())) {
    const page = await withinCleanupTimeout(context.newPage());
    try {
      await withinCleanupTimeout(
        page.goto(`chrome-extension://${extensionId}/popup.html`, {
          waitUntil: "commit",
        }),
      );
      await clearStorage(page);
      return;
    } catch (error) {
      throw new Error(
        `popup cleanup fallback failed: ${sanitizeArtifactError(error)}`,
      );
    } finally {
      await withinCleanupTimeout(page.close()).catch(() => undefined);
    }
  }
  throw new Error(
    "No live extension page or worker is available to clear fixture storage",
  );
}

type ExtensionExecutionTarget =
  | Page
  | ReturnType<BrowserContext["serviceWorkers"]>[number];

async function readDiagnosticStorage(
  target: ExtensionExecutionTarget,
): Promise<DiagnosticEvent[]> {
  return target.evaluate(async () => {
    const stored = await chrome.storage.session.get();
    return Object.entries(stored)
      .filter(
        ([key]) => key.startsWith("nexus-e2e:") && key.includes(":event:"),
      )
      .map(([, value]) => value as DiagnosticEvent);
  });
}

async function clearStorage(target: ExtensionExecutionTarget): Promise<void> {
  await withinCleanupTimeout(
    target.evaluate(async () => {
      const clearArea = async (area: chrome.storage.StorageArea) => {
        const stored = await area.get();
        await area.remove(
          Object.keys(stored).filter((key) => key.startsWith("nexus-e2e:")),
        );
      };
      await clearArea(chrome.storage.session);
      await clearArea(chrome.storage.local);
    }),
  );
}

function isDeadTarget(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("Execution context was destroyed") ||
      error.message.includes("Target page, context or browser has been closed"))
  );
}

function isUnavailableCleanupTarget(error: unknown): boolean {
  return (
    isDeadTarget(error) ||
    (error instanceof Error &&
      error.message === "Timed out clearing fixture storage")
  );
}

async function attempt(
  errors: string[],
  operation: () => Promise<void>,
  bounded = true,
): Promise<void> {
  try {
    await (bounded ? withinCleanupTimeout(operation()) : operation());
  } catch (error) {
    errors.push(sanitizeArtifactError(error));
  }
}

async function cleanupStage(
  stages: string[],
  errors: string[],
  name: string,
  operation: () => Promise<void>,
  bounded = true,
): Promise<void> {
  const started = performance.now();
  const before = errors.length;
  await attempt(errors, operation, bounded);
  stages.push(
    `${name} ${Math.round(performance.now() - started)}ms ${errors.length === before ? "ok" : "failed"}`,
  );
}

export function sanitizeArtifactText(value: string): string {
  try {
    return sanitizeFixtureText(value);
  } catch {
    return "[unserializable artifact text]";
  }
}

export function sanitizeArtifactError(error: unknown): string {
  return sanitizeArtifactText(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
}

async function withinCleanupTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out clearing fixture storage")),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { expect };

export function bridgeResultKey(result: {
  readonly runId: string;
  readonly command: string;
  readonly sequence: number;
  readonly participant: string;
  readonly sessionId: string;
}): string {
  return JSON.stringify([
    result.runId,
    result.command,
    result.sequence,
    result.participant,
    result.sessionId,
  ]);
}

export function takeCorrelatedBridgeResult(
  results: Record<string, unknown>,
  expected: BridgeResultExpectation,
  options: BridgeResultWaitOptions = {},
): unknown {
  for (const [key, values] of Object.entries(results)) {
    if (!Array.isArray(values)) continue;
    for (const [index, value] of values.entries()) {
      const result = parseBridgeResult(value, expected);
      if (
        result &&
        result.participant === expected.participant &&
        (expected.sessionId === undefined ||
          result.sessionId === expected.sessionId) &&
        (options.valueMatches?.(result.value) ?? true)
      ) {
        values.splice(index, 1);
        if (values.length === 0) delete results[key];
        return result;
      }
    }
  }
  return null;
}

export async function waitForHostBridgeResult(
  page: Page,
  expected: BridgeResultExpectation,
  options: BridgeResultWaitOptions = {},
): Promise<unknown> {
  const result = await pollUntil(
    () =>
      page.evaluate((expected) => {
        const bridge = window as typeof window & {
          __nexusE2eResults?: Record<string, unknown[]>;
        };
        const results = bridge.__nexusE2eResults;
        if (!results) return [];
        const candidates: Array<{
          readonly index: number;
          readonly key: string;
          readonly value: unknown;
        }> = [];
        for (const [key, values] of Object.entries(results)) {
          if (!Array.isArray(values)) continue;
          for (const [index, value] of values.entries()) {
            if (
              value &&
              typeof value === "object" &&
              (value as Record<string, unknown>).runId === expected.runId &&
              (value as Record<string, unknown>).command === expected.command &&
              (value as Record<string, unknown>).sequence ===
                expected.sequence &&
              (value as Record<string, unknown>).participant ===
                expected.participant &&
              (expected.sessionId === undefined ||
                (value as Record<string, unknown>).sessionId ===
                  expected.sessionId)
            ) {
              candidates.push({ index, key, value });
            }
          }
        }
        return candidates;
      }, expected),
    (candidates) =>
      candidates.some(
        (candidate) =>
          !options.valueMatches ||
          options.valueMatches(
            (candidate.value as { readonly value: string }).value,
          ),
      ),
  );
  if (result.matched) {
    const candidates = result.value ?? [];
    const candidate = candidates.find(
      (candidate) =>
        !options.valueMatches ||
        options.valueMatches(
          (candidate.value as { readonly value: string }).value,
        ),
    ) as {
      readonly index: number;
      readonly key: string;
      readonly value: unknown;
    };
    return page.evaluate(({ index, key }) => {
      const bridge = window as typeof window & {
        __nexusE2eResults?: Record<string, unknown[]>;
      };
      const values = bridge.__nexusE2eResults?.[key];
      if (!values) return null;
      const [value] = values.splice(index, 1);
      if (values.length === 0) delete bridge.__nexusE2eResults![key];
      return value ?? null;
    }, candidate);
  }
  throw new BarrierTimeoutError("correlated DOM result", [
    JSON.stringify(expected),
  ]);
}

function assertRunId(runId: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) {
    throw new Error(`Invalid fixture runId: ${runId}`);
  }
}

function isResultEvent(event: DiagnosticEvent): event is ResultEvent {
  return event.kind === "result";
}

async function pollUntil<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
): Promise<{ readonly value: T; readonly matched: boolean }> {
  const deadline = Date.now() + 5_000;
  let value: T | undefined;
  while (Date.now() < deadline) {
    value = await read();
    if (matches(value)) return { value, matched: true };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { value: value as T, matched: false };
}

async function dispatchBridgeCommand(
  page: Page,
  runId: string,
  command: string,
  sessionId?: string,
): Promise<number> {
  const sequence = (commandSequences.get(page) ?? 0) + 1;
  commandSequences.set(page, sequence);
  await page.evaluate(
    ({ runId, command, sequence, sessionId }) =>
      window.dispatchEvent(
        new CustomEvent("nexus-e2e-command", {
          detail: {
            kind: "command",
            runId,
            command,
            sequence,
            ...(sessionId === undefined ? {} : { sessionId }),
          },
        }),
      ),
    { runId, command, sequence, sessionId },
  );
  return sequence;
}

async function readDomValue(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate((element) =>
      element instanceof HTMLDataElement || element instanceof HTMLOutputElement
        ? element.value
        : (element.textContent ?? ""),
    );
}

async function waitForChangedDomValue(
  page: Page,
  selector: string,
  before: string | null,
): Promise<string> {
  const result = await pollUntil(
    () => readDomValue(page, selector),
    (value) => value !== before,
  );
  if (result.matched) return result.value;
  throw new BarrierTimeoutError("DOM result", [
    before ?? "",
    result.value ?? before ?? "",
  ]);
}

export function diagnosticEventIdentity(event: DiagnosticEvent): string {
  return [
    event.runId,
    event.participant,
    event.sessionId ?? "none",
    event.sequence,
    event.kind,
  ].join(":");
}

export function diagnosticCursor(
  events: readonly DiagnosticEvent[],
): DiagnosticCursor {
  return new Set(events.map(diagnosticEventIdentity));
}

export function selectDispatchCursor(
  events: readonly DiagnosticEvent[],
  after?: DiagnosticCursor,
): DiagnosticCursor {
  return after ?? diagnosticCursor(events);
}

async function readRunDiagnostics(
  context: BrowserContext,
  runId: string,
): Promise<readonly DiagnosticEvent[]> {
  assertRunId(runId);
  const events = (await readDiagnostics(context)).filter(
    (event) => event.runId === runId,
  );
  Diagnostics.validate(events);
  return Diagnostics.sort(events);
}

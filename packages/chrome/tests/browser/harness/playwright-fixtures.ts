import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { outputDirectory } from "../build-extension";
import type { DiagnosticEvent } from "../protocol";
import { sanitizeFixtureText } from "../extension/shared/runtime";
import {
  BarrierTimeoutError,
  waitForBarrier as waitForDiagnosticBarrier,
} from "./barriers";
import { Diagnostics } from "./diagnostics";
import {
  extensionTargetNdjson,
  launchExtension,
  type ExtensionLaunch,
} from "./launch-extension";
import { ServiceWorkerController } from "./service-worker-controller";

type ResultEvent = DiagnosticEvent & {
  readonly kind: "result";
  readonly value: string;
};
export type DiagnosticCursor = ReadonlySet<string>;
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
  ) => Promise<DiagnosticCursor>;
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
  readonly fixtureStorage: () => Promise<{
    readonly session: Readonly<Record<string, unknown>>;
    readonly local: Readonly<Record<string, unknown>>;
  }>;
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
        await cleanupStage(
          cleanupStages,
          cleanupErrors,
          "detach-target-observer",
          () => launch.detachTargetObserver(),
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
    const sequences = new WeakMap<Page, number>();
    await use(async (page, runId, command, options = {}) => {
      assertRunId(runId);
      const cursor =
        options.after ?? selectDispatchCursor(await diagnostics(runId));
      const sequence = (sequences.get(page) ?? 0) + 1;
      sequences.set(page, sequence);
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
        { runId, command, sequence, sessionId: options.sessionId },
      );
      return cursor;
    });
  },
  waitForDomValue: async ({}, use) =>
    use(async (page, selector, before) => {
      let value = before;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        value = await page
          .locator(selector)
          .evaluate((element) =>
            element instanceof HTMLDataElement
              ? element.value
              : (element.textContent ?? ""),
          );
        if (value !== before) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new BarrierTimeoutError("DOM result", [before ?? "", value ?? ""]);
    }),
  waitForEvent: async ({ diagnostics }, use) =>
    use(async (runId, predicate, options = {}) => {
      assertRunId(runId);
      const count = options.count ?? 1;
      let events: readonly DiagnosticEvent[] = [];
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        events = await diagnostics(runId);
        const matches = events.filter(
          (event) =>
            !options.after?.has(diagnosticEventIdentity(event)) &&
            predicate(event),
        );
        if (matches.length >= count) return matches;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new BarrierTimeoutError(
        "diagnostic event",
        events.map((event) => JSON.stringify(event)),
      );
    }),
  waitForResult: async ({ waitForEvent }, use) =>
    use(async (runId, predicate, options = {}) => {
      const events = await waitForEvent(
        runId,
        (event) => isResultEvent(event) && predicate(event),
        options,
      );
      return events.find(
        (event) => isResultEvent(event) && predicate(event),
      ) as ResultEvent;
    }),
  fixtureStorage: async ({ launch }, use) =>
    use(async () => readFixtureStorage(launch.context)),
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
  readonly testInfo: Parameters<typeof base>[0] extends never ? never : any;
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
  try {
    await writeAndAttachTextArtifact(
      testInfo,
      cleanupErrors,
      "manifest-output-hash",
      await readFile(join(outputDirectory, ".nexus-e2e-output.sha256"), "utf8"),
    );
  } catch (error) {
    await writeAndAttachTextArtifact(
      testInfo,
      cleanupErrors,
      "manifest-read-error.log",
      sanitizeArtifactError(error),
    );
  }
  await writeAndAttachTextArtifact(
    testInfo,
    cleanupErrors,
    "worker-urls",
    sanitizeArtifactText(launch.workerUrls.join("\n")),
  );
  await writeAndAttachTextArtifact(
    testInfo,
    cleanupErrors,
    "extension-targets.ndjson",
    extensionTargetNdjson(launch.targetHistory),
    "application/x-ndjson",
  );
  await writeAndAttachTextArtifact(
    testInfo,
    cleanupErrors,
    "extension-runtime.log",
    sanitizeArtifactText(launch.runtimeLogs.join("\n")),
  );
}

async function writeAndAttachTextArtifact(
  testInfo: Parameters<typeof base>[0] extends never ? never : any,
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
      return await readStorage(page);
    } catch (error) {
      if (!isUnavailableCleanupTarget(error)) throw error;
    }
  }
  for (const worker of [...context.serviceWorkers()].reverse()) {
    try {
      return await worker.evaluate(async () => {
        const stored = await chrome.storage.session.get();
        return Object.entries(stored)
          .filter(
            ([key]) => key.startsWith("nexus-e2e:") && key.includes(":event:"),
          )
          .map(([, value]) => value as DiagnosticEvent);
      });
    } catch (error) {
      if (!isUnavailableCleanupTarget(error)) throw error;
    }
  }
  return [];
}

async function readStorage(page: Page): Promise<DiagnosticEvent[]> {
  return page.evaluate(async () => {
    const stored = await chrome.storage.session.get();
    return Object.entries(stored)
      .filter(
        ([key]) => key.startsWith("nexus-e2e:") && key.includes(":event:"),
      )
      .map(([, value]) => value as DiagnosticEvent);
  });
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
      await clearStorageInPage(page);
      return;
    } catch (error) {
      if (!isUnavailableCleanupTarget(error)) throw error;
    }
  }
  for (const worker of [...context.serviceWorkers()].reverse()) {
    try {
      await withinCleanupTimeout(
        worker.evaluate(async () => {
          const session = await chrome.storage.session.get();
          await chrome.storage.session.remove(
            Object.keys(session).filter((key) => key.startsWith("nexus-e2e:")),
          );
          const local = await chrome.storage.local.get();
          await chrome.storage.local.remove(
            Object.keys(local).filter((key) => key.startsWith("nexus-e2e:")),
          );
        }),
      );
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
      await clearStorageInPage(page);
      return;
    } catch (error) {
      throw new Error(`popup cleanup fallback failed: ${formatError(error)}`);
    } finally {
      await withinCleanupTimeout(page.close()).catch(() => undefined);
    }
  }
  throw new Error(
    "No live extension page or worker is available to clear fixture storage",
  );
}

async function clearStorageInPage(page: Page): Promise<void> {
  await withinCleanupTimeout(
    page.evaluate(async () => {
      const session = await chrome.storage.session.get();
      await chrome.storage.session.remove(
        Object.keys(session).filter((key) => key.startsWith("nexus-e2e:")),
      );
      const local = await chrome.storage.local.get();
      await chrome.storage.local.remove(
        Object.keys(local).filter((key) => key.startsWith("nexus-e2e:")),
      );
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
): Promise<void> {
  try {
    await withinCleanupTimeout(operation());
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
  await (bounded
    ? attempt(errors, operation)
    : attemptWithoutTimeout(errors, operation));
  stages.push(
    `${name} ${Math.round(performance.now() - started)}ms ${errors.length === before ? "ok" : "failed"}`,
  );
}

async function attemptWithoutTimeout(
  errors: string[],
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(sanitizeArtifactError(error));
  }
}

function formatError(error: unknown): string {
  return sanitizeArtifactError(error);
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

function assertRunId(runId: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) {
    throw new Error(`Invalid fixture runId: ${runId}`);
  }
}

function isResultEvent(event: DiagnosticEvent): event is ResultEvent {
  return event.kind === "result";
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

async function readFixtureStorage(context: BrowserContext): Promise<{
  readonly session: Readonly<Record<string, unknown>>;
  readonly local: Readonly<Record<string, unknown>>;
}> {
  for (const page of [...context.pages()].reverse()) {
    if (!page.url().startsWith("chrome-extension://")) continue;
    try {
      return await page.evaluate(async () => {
        const pick = (values: Record<string, unknown>) =>
          Object.fromEntries(
            Object.entries(values).filter(([key]) =>
              key.startsWith("nexus-e2e:"),
            ),
          );
        return {
          session: pick(await chrome.storage.session.get()),
          local: pick(await chrome.storage.local.get()),
        };
      });
    } catch (error) {
      if (!isDeadTarget(error)) throw error;
    }
  }
  throw new Error("No live extension page is available for fixture storage");
}

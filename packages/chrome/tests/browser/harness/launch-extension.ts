import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputDirectory } from "../build-extension";
import { sanitizeFixtureText } from "../extension/shared/runtime";

export interface ExtensionLaunch {
  readonly context: BrowserContext;
  readonly userDataDir: string;
  readonly extensionId: string;
  readonly workerUrls: string[];
  readonly targetHistory: ExtensionTarget[];
  readonly runtimeLogs: string[];
  readonly waitForExtensionTarget: (
    predicate: (target: ExtensionTarget) => boolean,
    timeout?: number,
  ) => Promise<ExtensionTarget>;
  readonly detachTargetObserver: () => Promise<void>;
}

export interface ExtensionTarget {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly attached: boolean;
  readonly event:
    | "created"
    | "changed"
    | "destroyed"
    | "snapshot"
    | "attached"
    | "detached";
  readonly timestamp: string;
}

export async function launchExtension(): Promise<ExtensionLaunch> {
  const userDataDir = await mkdtemp(join(tmpdir(), "nexus-chrome-e2e-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${outputDirectory}`,
        `--load-extension=${outputDirectory}`,
      ],
    });
    const workerUrls: string[] = [];
    const recordWorker = (worker: { url(): string }) =>
      workerUrls.push(sanitizeEvidenceText(worker.url()));
    context.serviceWorkers().forEach(recordWorker);
    context.on("serviceworker", recordWorker);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 5_000 }));
    const extensionId = new URL(worker.url()).host;
    const browser = context.browser();
    if (!browser)
      throw new Error("Persistent extension context has no browser");
    const cdp = await browser.newBrowserCDPSession();
    const targetHistory: ExtensionTarget[] = [];
    const runtimeLogs: string[] = [];
    const observedBackgroundPages = new WeakSet<Page>();
    const knownTargets = new Map<string, { type: string; url: string }>();
    const attachments = createAttachmentGuard();
    const observedSessions = new Map<string, string>();
    runtimeLogs.push(
      "service-worker Runtime/Log capture unavailable: passive target observation mode",
    );
    cdp.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      if (!attachments.sessions().includes(sessionId)) return;
      const entry = parseTargetRuntimeMessage(sessionId, sessionId, message);
      if (entry)
        runtimeLogs.push(
          `target ${observedSessions.get(sessionId) ?? "unknown"} (${sessionId}): ${entry}`,
        );
    });
    const observeBackgroundPage = (page: Page) => {
      if (observedBackgroundPages.has(page)) return;
      observedBackgroundPages.add(page);
      page.on("console", (message) =>
        runtimeLogs.push(
          `background page console ${sanitizeEvidenceText(page.url())}: ${sanitizeEvidenceText(message.text())}`,
        ),
      );
      page.on("pageerror", (error) =>
        runtimeLogs.push(
          `background page error ${sanitizeEvidenceText(page.url())}: ${sanitizeError(error)}`,
        ),
      );
      void captureBackgroundPageDiagnostic(page, runtimeLogs);
    };
    const initialBackgroundPages = context.backgroundPages();
    runtimeLogs.push(
      `Playwright backgroundPages initial count: ${initialBackgroundPages.length}`,
    );
    initialBackgroundPages.forEach(observeBackgroundPage);
    context.on("backgroundpage", (page) => {
      runtimeLogs.push(`Playwright backgroundpage event: ${page.url()}`);
      observeBackgroundPage(page);
    });
    const record = (
      event: ExtensionTarget["event"],
      target: {
        targetId: string;
        type: string;
        url: string;
        attached?: boolean;
      },
    ) => {
      if (!isExtensionTarget(extensionId, target.url)) return;
      if (!shouldRecordTargetState(knownTargets, target)) return;
      targetHistory.push({
        targetId: target.targetId,
        type: target.type,
        url: sanitizeEvidenceText(target.url),
        attached: target.attached ?? false,
        event,
        timestamp: new Date().toISOString(),
      });
    };
    cdp.on("Target.targetCreated", ({ targetInfo }) => {
      record("created", targetInfo);
      if (isOffscreenExtensionTarget(extensionId, targetInfo)) {
        void attachOffscreenTarget(
          cdp,
          targetInfo,
          attachments,
          observedSessions,
          targetHistory,
          runtimeLogs,
        );
      }
    });
    cdp.on("Target.targetInfoChanged", ({ targetInfo }) => {
      record("changed", targetInfo);
      if (isOffscreenExtensionTarget(extensionId, targetInfo)) {
        void attachOffscreenTarget(
          cdp,
          targetInfo,
          attachments,
          observedSessions,
          targetHistory,
          runtimeLogs,
        );
      }
    });
    cdp.on("Target.targetDestroyed", ({ targetId }) => {
      const target = knownTargets.get(targetId);
      if (!target) return;
      runtimeLogs.push(
        `target destroyed ${targetId} ${target.type} ${sanitizeEvidenceText(target.url)}`,
      );
      targetHistory.push({
        targetId,
        type: target.type,
        url: sanitizeEvidenceText(target.url),
        attached: false,
        event: "destroyed",
        timestamp: new Date().toISOString(),
      });
      knownTargets.delete(targetId);
    });
    cdp.on("Target.detachedFromTarget", ({ sessionId, targetId }) => {
      const label = observedSessions.get(sessionId);
      if (label)
        runtimeLogs.push(
          `target detached ${label} (${sessionId})${targetId ? ` targetId=${targetId}` : ""}`,
        );
      observedSessions.delete(sessionId);
    });
    try {
      await cdp.send("Target.setDiscoverTargets", { discover: true });
    } catch (error) {
      runtimeLogs.push(`Target.setDiscoverTargets: ${formatError(error)}`);
    }
    const snapshot = await cdp.send("Target.getTargets");
    snapshot.targetInfos.forEach((target) => record("snapshot", target));
    for (const target of snapshot.targetInfos) {
      if (!isOffscreenExtensionTarget(extensionId, target)) continue;
      await attachOffscreenTarget(
        cdp,
        target,
        attachments,
        observedSessions,
        targetHistory,
        runtimeLogs,
      );
    }
    return {
      context,
      userDataDir,
      extensionId,
      workerUrls,
      targetHistory,
      runtimeLogs,
      waitForExtensionTarget: async (predicate, timeout = 5_000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const targets = await cdp.send("Target.getTargets");
          const match = targets.targetInfos
            .filter((target) => isExtensionTarget(extensionId, target.url))
            .map((target) => ({
              targetId: target.targetId,
              type: target.type,
              url: target.url,
              attached:
                attachments.attachedSession(target.targetId) !== undefined,
              event: "snapshot" as const,
              timestamp: new Date().toISOString(),
            }))
            .find(predicate);
          if (match) return match;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(
          `Timed out waiting for extension target after ${timeout}ms`,
        );
      },
      detachTargetObserver: async () => {
        await withinTimeout(attachments.settle(), 1_000).catch((error) =>
          runtimeLogs.push(`Target attachment settle: ${formatError(error)}`),
        );
        await Promise.allSettled(
          attachments
            .sessions()
            .map((sessionId) =>
              withinTimeout(
                cdp.send("Target.detachFromTarget", { sessionId }),
                1_000,
              ),
            ),
        );
        await withinTimeout(cdp.detach(), 1_000).catch((error) =>
          runtimeLogs.push(`Target observer detach: ${formatError(error)}`),
        );
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

export function isExtensionTarget(extensionId: string, url: string): boolean {
  return url.startsWith(`chrome-extension://${extensionId}/`);
}

export function extensionTargetNdjson(
  targets: readonly ExtensionTarget[],
): string {
  return (
    targets.map((target) => JSON.stringify(target)).join("\n") +
    (targets.length > 0 ? "\n" : "")
  );
}

export function formatBackgroundPageDiagnostic(diagnostic: {
  readonly url: string;
  readonly readyState: string;
  readonly runtimeLastError: string | null;
}): string {
  return `background page: ${sanitizeEvidenceText(JSON.stringify(diagnostic))}`;
}

export function sanitizeEvidenceText(value: string): string {
  try {
    return sanitizeFixtureText(value);
  } catch {
    return "[unserializable evidence]";
  }
}

export function sanitizeError(error: unknown): string {
  return sanitizeEvidenceText(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
}

export function shouldRecordTargetState(
  states: Map<string, { type: string; url: string }>,
  target: { targetId: string; type: string; url: string },
): boolean {
  const previous = states.get(target.targetId);
  if (previous?.type === target.type && previous.url === target.url)
    return false;
  states.set(target.targetId, { type: target.type, url: target.url });
  return true;
}

export function createAttachmentGuard(): {
  attach: (
    targetId: string,
    operation: () => Promise<string>,
  ) => Promise<{ sessionId: string; created: boolean }>;
  attachedSession: (targetId: string) => string | undefined;
  sessions: () => string[];
  settle: () => Promise<void>;
} {
  const pending = new Map<string, Promise<string>>();
  const attached = new Map<string, string>();
  return {
    attach: (targetId, operation) => {
      const session = attached.get(targetId);
      if (session)
        return Promise.resolve({ sessionId: session, created: false });
      const existing = pending.get(targetId);
      if (existing)
        return existing.then((sessionId) => ({ sessionId, created: false }));
      const attachment = operation().then((sessionId) => {
        attached.set(targetId, sessionId);
        return sessionId;
      });
      pending.set(targetId, attachment);
      void attachment.then(
        () => pending.delete(targetId),
        () => pending.delete(targetId),
      );
      return attachment.then((sessionId) => ({ sessionId, created: true }));
    },
    attachedSession: (targetId) => attached.get(targetId),
    sessions: () => [...attached.values()],
    settle: async () => {
      await Promise.allSettled(pending.values());
    },
  };
}

export function isOffscreenExtensionTarget(
  extensionId: string,
  target: { type: string; url: string },
): boolean {
  return (
    target.type !== "service_worker" &&
    isExtensionTarget(extensionId, target.url) &&
    new URL(target.url).pathname.endsWith("/offscreen.html")
  );
}

async function attachOffscreenTarget(
  cdp: CDPSession,
  target: { targetId: string; type: string; url: string },
  attachments: ReturnType<typeof createAttachmentGuard>,
  observedSessions: Map<string, string>,
  targetHistory: ExtensionTarget[],
  runtimeLogs: string[],
): Promise<void> {
  try {
    const attachment = await attachments.attach(target.targetId, async () => {
      const result = await cdp.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: false,
      });
      return result.sessionId;
    });
    if (!attachment.created) return;
    observedSessions.set(
      attachment.sessionId,
      `${target.type} ${target.targetId} ${sanitizeEvidenceText(target.url)}`,
    );
    targetHistory.push({
      targetId: target.targetId,
      type: target.type,
      url: sanitizeEvidenceText(target.url),
      attached: true,
      event: "attached",
      timestamp: new Date().toISOString(),
    });
    await enableTargetRuntime(cdp, attachment.sessionId, target, runtimeLogs);
  } catch (error) {
    runtimeLogs.push(`attach ${target.targetId}: ${formatError(error)}`);
  }
}

async function enableTargetRuntime(
  cdp: CDPSession,
  sessionId: string,
  target: { targetId: string; type: string; url: string },
  runtimeLogs: string[],
): Promise<void> {
  for (const [id, method] of [
    [1, "Runtime.enable"],
    [2, "Log.enable"],
  ] as const) {
    try {
      await cdp.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id, method }),
      });
    } catch (error) {
      runtimeLogs.push(
        `target ${target.type} ${target.targetId} ${sanitizeEvidenceText(target.url)} (${sessionId}) ${method}: ${formatError(error)}`,
      );
    }
  }
}

export function parseTargetRuntimeMessage(
  observedSessionId: string | undefined,
  sessionId: string,
  message: string,
): string | undefined {
  if (observedSessionId !== sessionId) return undefined;
  try {
    const entry = JSON.parse(message) as {
      id?: number;
      method?: string;
      params?: unknown;
      error?: unknown;
    };
    if (
      entry.method === "Runtime.consoleAPICalled" ||
      entry.method === "Runtime.exceptionThrown" ||
      entry.method === "Log.entryAdded" ||
      (entry.id !== undefined && entry.error !== undefined)
    ) {
      return sanitizeEvidenceText(JSON.stringify(entry));
    }
  } catch {
    return `invalid nested CDP message: ${sanitizeEvidenceText(message)}`;
  }
  return undefined;
}

async function captureBackgroundPageDiagnostic(
  page: Page,
  runtimeLogs: string[],
): Promise<void> {
  try {
    const diagnostic = await withinTimeout(
      page.evaluate(() => ({
        url: location.href,
        readyState: document.readyState,
        runtimeLastError: chrome.runtime.lastError?.message ?? null,
      })),
      1_000,
    );
    runtimeLogs.push(formatBackgroundPageDiagnostic(diagnostic));
  } catch (error) {
    runtimeLogs.push(
      `background page diagnostic ${sanitizeEvidenceText(page.url())}: ${formatError(error)}`,
    );
  }
}

export async function withinTimeout<T>(
  operation: Promise<T>,
  timeout: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeout}ms`)),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatError(error: unknown): string {
  return sanitizeError(error);
}

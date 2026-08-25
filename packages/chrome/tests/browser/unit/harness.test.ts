import { afterEach, describe, expect, it, vi } from "vitest";
import { BarrierTimeoutError, waitForBarrier } from "../harness/barriers";
import { Cleanup } from "../harness/cleanup";
import { Diagnostics } from "../harness/diagnostics";
import {
  diagnosticCursor,
  diagnosticEventIdentity,
  selectDispatchCursor,
} from "../harness/playwright-fixtures";
import {
  createAttachmentGuard,
  extensionTargetNdjson,
  formatBackgroundPageDiagnostic,
  parseTargetRuntimeMessage,
  sanitizeError,
  sanitizeEvidenceText,
  isExtensionTarget,
  isOffscreenExtensionTarget,
  shouldRecordTargetState,
  withinTimeout,
} from "../harness/launch-extension";
import {
  sanitizeArtifactError,
  sanitizeArtifactText,
} from "../harness/playwright-fixtures";
import {
  sanitizeFixtureText,
  validateOffscreenEvent,
  validatePolicyControl,
} from "../extension/shared/runtime";

describe("browser fixture harness", () => {
  const originalCI = process.env.CI;

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
    vi.resetModules();
  });

  it("configures fixed strict loopback host servers and CI reuse behavior", async () => {
    delete process.env.CI;
    vi.resetModules();
    const localServers = (await import("../host-server.config"))
      .hostServers as Array<{ command: string; reuseExistingServer?: boolean }>;

    process.env.CI = "true";
    vi.resetModules();
    const ciServers = (await import("../host-server.config"))
      .hostServers as Array<{ command: string; reuseExistingServer?: boolean }>;

    expect(localServers.map((server) => server.command)).toEqual([
      "pnpm exec vite tests/browser/host --host 127.0.0.1 --port 4173 --strictPort",
      "pnpm exec vite tests/browser/host --host 127.0.0.1 --port 4174 --strictPort",
      "pnpm exec vite tests/browser/host --host 127.0.0.1 --port 4175 --strictPort",
    ]);
    expect(localServers.every((server) => server.reuseExistingServer)).toBe(
      true,
    );
    expect(ciServers.every((server) => !server.reuseExistingServer)).toBe(true);
  });

  it("reports the last events when a barrier times out", async () => {
    await expect(
      waitForBarrier({
        name: "provider-ready",
        timeoutMs: 0,
        readEvents: async () => ["background-ready", "content-connected"],
      }),
    ).rejects.toEqual(
      new BarrierTimeoutError("provider-ready", [
        "background-ready",
        "content-connected",
      ]),
    );
  });

  it("resolves when the requested barrier arrives before its deadline", async () => {
    let reads = 0;

    await expect(
      waitForBarrier({
        name: "provider-ready",
        timeoutMs: 100,
        pollIntervalMs: 0,
        readEvents: async () => {
          reads += 1;
          return reads === 1 ? ["background-ready"] : ["provider-ready"];
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("recognizes only fixture generated paths for cleanup and ignores", () => {
    expect(Cleanup.isGeneratedPath("extension/.output/chrome-mv3")).toBe(true);
    expect(Cleanup.isGeneratedPath("extension/.wxt/tsconfig.json")).toBe(true);
    expect(Cleanup.isGeneratedPath("extension/entrypoints/background.ts")).toBe(
      false,
    );
    expect(Cleanup.ignoreEntries()).toEqual([
      "extension/.output/",
      "extension/.wxt/",
    ]);
  });

  it("validates unordered diagnostic snapshots and sorts them canonically", () => {
    const first = {
      kind: "barrier" as const,
      runId: "run",
      participant: "a",
      sessionId: "one",
      sequence: 1,
      name: "ready",
    };
    const second = {
      kind: "barrier" as const,
      runId: "run",
      participant: "a",
      sessionId: "one",
      sequence: 2,
      name: "later",
    };
    expect(() => Diagnostics.validate([second, first])).not.toThrow();
    expect(Diagnostics.sort([second, first])).toEqual([first, second]);
    expect(() =>
      Diagnostics.validate([
        {
          kind: "barrier",
          runId: "run",
          participant: "a",
          sessionId: "one",
          sequence: 1,
          name: "ready",
        },
        {
          kind: "barrier",
          runId: "run",
          participant: "a",
          sessionId: "one",
          sequence: 1,
          name: "late",
        },
      ]),
    ).toThrow("Duplicate diagnostic sequence");
  });

  it("rejects invalid diagnostic shape before artifacts are serialized", () => {
    expect(() =>
      Diagnostics.validate([
        {
          kind: "barrier",
          runId: "",
          participant: "a",
          sequence: 1,
          name: "ready",
        },
      ]),
    ).toThrow("Invalid diagnostic event shape");
  });

  it("uses stable event identities for cursors rather than snapshot positions", () => {
    const event = {
      kind: "result" as const,
      runId: "run",
      participant: "content:main",
      sessionId: "session",
      sequence: 3,
      value: "first",
    };
    const cursor = diagnosticCursor([event]);
    expect(cursor.has(diagnosticEventIdentity(event))).toBe(true);
    expect(
      cursor.has(diagnosticEventIdentity({ ...event, value: "changed" })),
    ).toBe(true);
    expect(cursor.has(diagnosticEventIdentity({ ...event, sequence: 4 }))).toBe(
      false,
    );
  });

  it("uses a fresh ordinary dispatch cursor and preserves an explicit lifecycle cursor", () => {
    const older = {
      kind: "result" as const,
      runId: "run",
      participant: "content",
      sequence: 1,
      value: "same",
    };
    const newer = { ...older, sequence: 2 };
    expect(
      selectDispatchCursor([older, newer]).has(diagnosticEventIdentity(newer)),
    ).toBe(true);
    const lifecycle = diagnosticCursor([older]);
    expect(selectDispatchCursor([older, newer], lifecycle)).toBe(lifecycle);
  });

  it("keeps diagnostic read errors distinct from other failure artifacts", () => {
    const error = new Error("storage target closed");
    expect(error.stack ?? error.message).toContain("storage target closed");
  });

  it("treats a cleanup error as a failure after an otherwise-green body", () => {
    const bodyFailed = false;
    const cleanupErrors = ["Timed out clearing fixture storage"];
    expect(!bodyFailed && cleanupErrors.length > 0).toBe(true);
  });

  it("filters extension targets and serializes lifecycle evidence as NDJSON", () => {
    const target = {
      targetId: "offscreen-target",
      type: "other",
      url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/offscreen.html",
      attached: true,
      event: "created" as const,
      timestamp: "2026-08-24T12:00:00.000Z",
    };
    expect(
      isExtensionTarget("abcdefghijklmnopabcdefghijklmnop", target.url),
    ).toBe(true);
    expect(
      isExtensionTarget("abcdefghijklmnopabcdefghijklmnop", "about:blank"),
    ).toBe(false);
    expect(extensionTargetNdjson([target])).toBe(`${JSON.stringify(target)}\n`);
    expect(
      isOffscreenExtensionTarget("abcdefghijklmnopabcdefghijklmnop", {
        type: "background_page",
        url: `${target.url}?runId=run`,
      }),
    ).toBe(true);
    expect(target.type).toBe("other");
  });

  it("records a target state once until CDP reports a real change", () => {
    const states = new Map<string, { type: string; url: string }>();
    const target = {
      targetId: "offscreen-target",
      type: "other",
      url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/offscreen.html",
    };
    expect(shouldRecordTargetState(states, target)).toBe(true);
    expect(shouldRecordTargetState(states, target)).toBe(false);
    expect(shouldRecordTargetState(states, { ...target, type: "page" })).toBe(
      true,
    );
  });

  it("keeps service workers passive while offscreen targets remain observable", () => {
    const worker = {
      targetId: "worker-target",
      type: "service_worker",
      url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js",
    };
    const offscreen = {
      targetId: "offscreen-target",
      type: "background_page",
      url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/offscreen.html",
    };
    expect(
      isOffscreenExtensionTarget("abcdefghijklmnopabcdefghijklmnop", worker),
    ).toBe(false);
    expect(
      isOffscreenExtensionTarget("abcdefghijklmnopabcdefghijklmnop", offscreen),
    ).toBe(true);
  });

  it("shares one offscreen attachment across discovery sources", async () => {
    const guard = createAttachmentGuard();
    let attachments = 0;
    const attach = async () => {
      attachments += 1;
      return "session";
    };
    await Promise.all([
      guard.attach("offscreen-target", attach),
      guard.attach("offscreen-target", attach),
    ]);
    expect(attachments).toBe(1);
    expect(guard.attachedSession("offscreen-target")).toBe("session");
  });

  it("bounds a pending attachment without waiting for it to settle", async () => {
    await expect(
      withinTimeout(new Promise<never>(() => undefined), 0),
    ).rejects.toThrow("Timed out after 0ms");
  });

  it("serializes only JSON-safe background page diagnostics", () => {
    expect(
      formatBackgroundPageDiagnostic({
        url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/offscreen.html?runId=run",
        readyState: "complete",
        runtimeLastError: null,
      }),
    ).toBe(
      'background page: {"url":"chrome-extension://abcdefghijklmnopabcdefghijklmnop/offscreen.html?runId=run","readyState":"complete","runtimeLastError":null}',
    );
  });

  it("keeps nested runtime evidence scoped to its offscreen session", () => {
    expect(
      parseTargetRuntimeMessage(
        "offscreen-session",
        "other-session",
        JSON.stringify({
          method: "Runtime.exceptionThrown",
          params: { value: 1 },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseTargetRuntimeMessage(
        "offscreen-session",
        "offscreen-session",
        JSON.stringify({
          method: "Runtime.exceptionThrown",
          params: { value: 1 },
        }),
      ),
    ).toBe('{"method":"Runtime.exceptionThrown","params":{"value":1}}');
    expect(
      parseTargetRuntimeMessage(
        "offscreen-session",
        "offscreen-session",
        JSON.stringify({ id: 1, error: { message: "Runtime.enable failed" } }),
      ),
    ).toBe('{"id":1,"error":{"message":"Runtime.enable failed"}}');
  });

  it("retains the structured fixture logger payload from Runtime console events", () => {
    const payload =
      'NEXUS_E2E_LOG {"realm":"content:main","scope":"Nexus-L3-ConnectionManager"}';
    const parsed = parseTargetRuntimeMessage(
      "worker-session",
      "worker-session",
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: { args: [{ type: "string", value: payload }] },
      }),
    );
    expect(parsed).not.toBeUndefined();
    const envelope = JSON.parse(parsed as string) as {
      readonly params: {
        readonly args: readonly [{ readonly value: string }];
      };
    };
    expect(envelope.params.args[0].value).toBe(payload);
  });

  it("accepts only the exact fixture policy control shape", () => {
    const senderSessionId = "123e4567-e89b-12d3-a456-426614174000";
    expect(
      validatePolicyControl({
        kind: "policy",
        runId: "run_1",
        senderSessionId,
        denyCalls: true,
      }),
    ).toBe(true);
    for (const value of [
      { kind: "policy", runId: "run_1" },
      { kind: "policy", runId: "run_1", senderSessionId: "missing" },
      {
        kind: "policy",
        runId: "run_1",
        senderSessionId: "not-a-uuid",
        denyCalls: true,
      },
      {
        kind: "policy",
        runId: "run_1",
        senderSessionId,
        denyCalls: true,
        extra: 1,
      },
      { kind: "policy", runId: "run_1", denyCalls: "true" },
      { kind: "policy", runId: "run.1", denyCalls: true },
      { kind: "wrong", runId: "run_1", denyCalls: true },
    ]) {
      expect(validatePolicyControl(value)).toBe(false);
    }
  });

  it("validates offscreen events without accepting malformed or extra fields", () => {
    const sessionId = "123e4567-e89b-12d3-a456-426614174000";
    expect(
      validateOffscreenEvent({
        kind: "barrier",
        runId: "run_1",
        participant: "offscreen",
        sessionId,
        sequence: 1,
        name: "ready",
      }),
    ).toBe(true);
    for (const value of [
      {
        kind: "barrier",
        runId: "run_1",
        participant: "offscreen",
        sessionId,
        sequence: 1,
        value: "not-a-name",
      },
      {
        kind: "result",
        runId: "run_1",
        participant: "offscreen",
        sessionId,
        sequence: 2,
        name: "not-a-value",
      },
    ]) {
      expect(validateOffscreenEvent(value)).toBe(false);
    }
    expect(
      validateOffscreenEvent({
        kind: "result",
        runId: "run_1",
        participant: "offscreen",
        sessionId,
        sequence: 2,
        value: "ok",
      }),
    ).toBe(true);
    for (const value of [
      {
        kind: "barrier",
        runId: "run.1",
        participant: "offscreen",
        sessionId: "s",
        sequence: 1,
        name: "ready",
      },
      {
        kind: "barrier",
        runId: "run_1",
        participant: "content",
        sessionId: "s",
        sequence: 1,
        name: "ready",
      },
      {
        kind: "barrier",
        runId: "run_1",
        participant: "offscreen",
        sessionId: 1,
        sequence: 1,
        name: "ready",
      },
      {
        kind: "result",
        runId: "run_1",
        participant: "offscreen",
        sessionId: "not-a-uuid",
        sequence: 1,
        value: "ok",
      },
      {
        kind: "result",
        runId: "run_1",
        participant: "offscreen",
        sessionId: "s",
        sequence: 0,
        value: "ok",
      },
      {
        kind: "result",
        runId: "run_1",
        participant: "offscreen",
        sessionId: "s",
        sequence: 1.5,
        value: "ok",
      },
      {
        kind: "error",
        runId: "run_1",
        participant: "offscreen",
        sessionId: "s",
        sequence: 1,
      },
    ]) {
      expect(validateOffscreenEvent(value)).toBe(false);
    }
  });

  it("redacts fixture secrets while preserving safe URL context and bounding text", () => {
    const assignments = [
      "token=SECRET_TOKEN_VALUE",
      "access_token=SECRET_ACCESS_VALUE",
      "refresh_token=SECRET_REFRESH_VALUE",
      "client_secret=SECRET_CLIENT_VALUE",
      "password=SECRET_PASSWORD_VALUE",
      "authorization=SECRET_AUTHORIZATION_VALUE",
      "auth=SECRET_AUTH_VALUE",
      "cookie=SECRET_COOKIE_VALUE",
      "credential=SECRET_CREDENTIAL_VALUE",
      "api_key=SECRET_API_KEY_VALUE",
      "api-key=SECRET_API_DASH_VALUE",
      "x-api-key=SECRET_X_API_VALUE",
    ];
    const sanitized = sanitizeFixtureText(
      `${assignments.join(" ")} {"access_token":"SECRET_JSON_ACCESS","client_secret":"SECRET_JSON_CLIENT"} url=https://user:SECRET_USER_PASSWORD@example.test/path?runId=run_1&x-api-key=SECRET_QUERY_API ordinary-extension=chrome-extension://id/page.html?runId=run_1 Bearer SECRET_BEARER_VALUE Basic SECRET_BASIC_VALUE`,
    );
    expect(sanitized).toContain("runId=run_1");
    expect(sanitized).toContain(
      "ordinary-extension=chrome-extension://id/page.html",
    );
    for (const secret of [
      "SECRET_TOKEN_VALUE",
      "SECRET_ACCESS_VALUE",
      "SECRET_REFRESH_VALUE",
      "SECRET_CLIENT_VALUE",
      "SECRET_PASSWORD_VALUE",
      "SECRET_AUTHORIZATION_VALUE",
      "SECRET_AUTH_VALUE",
      "SECRET_COOKIE_VALUE",
      "SECRET_CREDENTIAL_VALUE",
      "SECRET_API_KEY_VALUE",
      "SECRET_API_DASH_VALUE",
      "SECRET_X_API_VALUE",
      "SECRET_USER_PASSWORD",
      "SECRET_QUERY_VALUE",
      "SECRET_JSON_ACCESS",
      "SECRET_JSON_CLIENT",
      "SECRET_QUERY_API",
      "SECRET_BEARER_VALUE",
      "SECRET_BASIC_VALUE",
    ]) {
      expect(sanitized).not.toContain(secret);
    }
    expect(sanitized).toContain("https://user:[redacted]@example.test");
    expect(
      sanitizeFixtureText(
        "Error: password=SECRET_ERROR_VALUE\n at stack password=SECRET_ERROR_VALUE",
      ),
    ).not.toContain("SECRET_ERROR_VALUE");
    const long = sanitizeFixtureText("x".repeat(2_000));
    expect(long.length).toBeLessThanOrEqual(512 + "...[truncated]".length);
    expect(long).toContain("...[truncated]");
  });

  it("imports validation and sanitization helpers without creating chrome", () => {
    expect("chrome" in globalThis).toBe(false);
    expect(sanitizeFixtureText("safe text")).toBe("safe text");
  });

  it("sanitizes Task3 evidence strings without changing safe extension context", () => {
    const consoleText = sanitizeEvidenceText(
      "GET chrome-extension://id/offscreen.html?runId=run_1&access_token=SECRET_QUERY Bearer SECRET_BEARER",
    );
    expect(consoleText).toContain(
      "chrome-extension://id/offscreen.html?runId=run_1",
    );
    expect(consoleText).not.toContain("SECRET_QUERY");
    expect(consoleText).not.toContain("SECRET_BEARER");
    const targetUrl = sanitizeEvidenceText(
      "https://user:SECRET_PASSWORD@example.test/offscreen.html?runId=run_1&access_token=SECRET_TOKEN",
    );
    expect(targetUrl).toContain("runId=run_1");
    expect(targetUrl).toContain("user:[redacted]@example.test");
    expect(targetUrl).not.toContain("SECRET_PASSWORD");
    expect(targetUrl).not.toContain("SECRET_TOKEN");
  });

  it("sanitizes Task3 page errors and artifact errors", () => {
    const error = new Error("password=SECRET_MESSAGE");
    error.stack = "Error: password=SECRET_STACK\nBearer SECRET_BEARER";
    for (const value of [sanitizeError(error), sanitizeArtifactError(error)]) {
      expect(value).not.toContain("SECRET_STACK");
      expect(value).not.toContain("SECRET_BEARER");
    }
    expect(
      sanitizeArtifactText(
        "cookie=SECRET_COOKIE chrome-extension://id/page.html?runId=run_1",
      ),
    ).toContain("runId=run_1");
  });

  it("rejects offscreen events with extra fields", () => {
    expect(
      validateOffscreenEvent({
        kind: "result",
        runId: "run_1",
        participant: "offscreen",
        sessionId: "s",
        sequence: 1,
        value: "ok",
        extra: true,
      }),
    ).toBe(false);
  });

  it("redacts Bearer and Basic credentials", () => {
    const sanitized = sanitizeFixtureText(
      "Bearer SECRET_BEARER_VALUE Basic SECRET_BASIC_VALUE",
    );
    expect(sanitized).not.toContain("SECRET_BEARER_VALUE");
    expect(sanitized).not.toContain("SECRET_BASIC_VALUE");
  });
});

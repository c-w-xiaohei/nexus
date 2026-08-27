import { afterEach, describe, expect, it, vi } from "vitest";
import { BarrierTimeoutError, waitForBarrier } from "../harness/barriers";
import { Diagnostics } from "../harness/diagnostics";
import {
  bridgeResultKey,
  takeCorrelatedBridgeResult,
  diagnosticCursor,
  diagnosticEventIdentity,
  selectDispatchCursor,
} from "../harness/playwright-fixtures";
import {
  sanitizeArtifactError,
  sanitizeArtifactText,
} from "../harness/playwright-fixtures";
import {
  sanitizeFixtureText,
  validateOffscreenEvent,
} from "../extension/shared/runtime";
import { parseBridgeResult } from "../protocol";

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

  it("parses only correlated command results from a calling realm DOM output", () => {
    const result = parseBridgeResult(
      {
        kind: "result",
        runId: "run",
        command: "create-frame",
        sequence: 4,
        participant: "content:alpha",
        sessionId: "123e4567-e89b-12d3-a456-426614174000",
        value: '{"identity":{"label":"alpha"}}',
      },
      { runId: "run", command: "create-frame", sequence: 4 },
    );

    expect(result).toMatchObject({ participant: "content:alpha" });
    expect(
      parseBridgeResult(
        { ...result!, sequence: 5 },
        { runId: "run", command: "create-frame", sequence: 4 },
      ),
    ).toBeUndefined();
  });

  it("takes the exact result when concurrent results arrive out of order", () => {
    const alpha = {
      kind: "result" as const,
      runId: "run",
      command: "create-frame",
      sequence: 2,
      participant: "content:alpha",
      sessionId: "alpha-session",
      value: "alpha",
    };
    const beta = { ...alpha, participant: "content:beta", value: "beta" };
    const intermediate = { ...alpha, value: "background:1:nonce" };
    const results = {
      [bridgeResultKey(beta)]: [beta],
      [bridgeResultKey(alpha)]: [intermediate, alpha],
    };

    expect(
      takeCorrelatedBridgeResult(results, {
        runId: "run",
        command: "create-frame",
        sequence: 2,
        participant: "content:beta",
      }),
    ).toEqual(beta);
    expect(results).toEqual({
      [bridgeResultKey(alpha)]: [intermediate, alpha],
    });
    expect(
      takeCorrelatedBridgeResult(
        results,
        {
          runId: "run",
          command: "create-frame",
          sequence: 2,
          participant: "content:alpha",
        },
        { valueMatches: (value) => value === "alpha" },
      ),
    ).toEqual(alpha);
    expect(results).toEqual({ [bridgeResultKey(alpha)]: [intermediate] });
    expect(
      takeCorrelatedBridgeResult(results, {
        runId: "run",
        command: "create-frame",
        sequence: 2,
        participant: "content:alpha",
      }),
    ).toEqual(intermediate);
    expect(results).toEqual({});
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

  it("sanitizes artifact errors", () => {
    const error = new Error("password=SECRET_MESSAGE");
    error.stack = "Error: password=SECRET_STACK\nBearer SECRET_BEARER";
    const value = sanitizeArtifactError(error);
    expect(value).not.toContain("SECRET_STACK");
    expect(value).not.toContain("SECRET_BEARER");
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

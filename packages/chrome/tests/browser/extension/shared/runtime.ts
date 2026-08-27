/// <reference types="chrome" />

import { configureNexusLogger, LogLevel } from "@nexus-js/core";
import { eventKey, type BridgeEvent } from "../../protocol";

export const fixturePrefix = "nexus-e2e:";
export const fixtureLoggerPrefix = "NEXUS_E2E_LOG ";
export const activeRunKey = `${fixturePrefix}active-run`;
const maxLoggerDepth = 4;
const maxLoggerEntries = 24;
const maxLoggerStringLength = 512;
const sensitiveLoggerKey =
  /^(?:.*(?:access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|authorization|auth|cookie|credential|api[_-]?key|x[_-]?api[_-]?key).*)$/i;
const reporterStates = new Map<
  string,
  { sequence: number; writes: Promise<void> }
>();

export interface FixtureIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly participant: string;
}

export function fixtureIdentity(
  participant: string,
  location: Location = window.location,
  sessionId: string = crypto.randomUUID(),
): FixtureIdentity | undefined {
  const runId = new URLSearchParams(location.search).get("runId");
  if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId)) return undefined;
  return {
    participant,
    runId,
    sessionId,
  };
}

export function hasStateClientFlag(
  location: Location = window.location,
  runId?: string,
): boolean {
  const params = new URLSearchParams(location.search);
  return (
    params.get("stateClient") === "1" &&
    (runId === undefined || params.get("runId") === runId)
  );
}

export function backgroundIdentity(): FixtureIdentity {
  return {
    participant: "background",
    runId: "",
    sessionId: crypto.randomUUID(),
  };
}

export function configureFixtureLogger(
  identity: Pick<FixtureIdentity, "participant" | "sessionId">,
  runId: string | (() => string | undefined) = "",
): void {
  configureNexusLogger({
    enabled: true,
    levels: {
      L2: LogLevel.DEBUG,
      L3: LogLevel.DEBUG,
      "*": LogLevel.WARN,
    },
    handler: (level, scope, message, ...args) => {
      try {
        const record = {
          timestamp: new Date().toISOString(),
          realm: sanitizeFixtureText(identity.participant),
          processSessionId: sanitizeFixtureText(identity.sessionId),
          runId:
            sanitizeFixtureText(
              typeof runId === "function" ? runId() || "" : runId || "",
            ) || null,
          level: {
            numeric: level,
            name: LogLevel[level] ?? String(level),
          },
          scope: sanitizeFixtureText(scope),
          message: sanitizeFixtureText(message),
          args: normalizeLoggerArgs(args),
        };
        console.log(`${fixtureLoggerPrefix}${JSON.stringify(record)}`);
      } catch {
        try {
          console.log(
            `${fixtureLoggerPrefix}${JSON.stringify({
              timestamp: new Date().toISOString(),
              realm: sanitizeFixtureText(identity.participant),
              processSessionId: sanitizeFixtureText(identity.sessionId),
              runId:
                sanitizeFixtureText(
                  typeof runId === "function" ? runId() || "" : runId || "",
                ) || null,
              level: {
                numeric: level,
                name: LogLevel[level] ?? String(level),
              },
              scope: "[unserializable]",
              message: "[unserializable]",
              args: ["[unserializable]"],
            })}`,
          );
        } catch {
          // Console failures must not affect Nexus control flow.
        }
      }
    },
  });
}

function normalizeLoggerArgs(args: readonly unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return args
    .slice(0, maxLoggerEntries)
    .map((value) => normalizeLoggerValue(value, 0, seen));
}

function normalizeLoggerValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null) return null;
  if (typeof value === "string") return sanitizeFixtureText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "bigint")
    return sanitizeFixtureText(`[bigint:${value.toString()}]`);
  if (typeof value === "symbol")
    return sanitizeFixtureText(`[symbol:${String(value)}]`);
  if (typeof value === "function")
    return sanitizeFixtureText(`[function:${value.name || "anonymous"}]`);
  if (depth >= maxLoggerDepth) return "[max-depth]";
  if (value instanceof Error) {
    return {
      name: sanitizeFixtureText(value.name),
      message: sanitizeFixtureText(value.message),
      stack: sanitizeFixtureText(value.stack ?? ""),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return sanitizeFixtureText(String(value));
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, maxLoggerEntries)
      .map((entry) => normalizeLoggerValue(entry, depth + 1, seen));
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return "[uninspectable]";
  }
  if (prototype !== null && prototype !== Object.prototype) {
    let constructorName = "object";
    try {
      if (typeof prototype.constructor?.name === "string") {
        constructorName = prototype.constructor.name;
      }
    } catch {
      constructorName = "uninspectable";
    }
    return sanitizeFixtureText(`[object:${constructorName}]`);
  }
  const result: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value).slice(0, maxLoggerEntries);
  } catch {
    return "[uninspectable]";
  }
  for (const key of keys) {
    if (sensitiveLoggerKey.test(key)) {
      result[sanitizeFixtureText(key)] = "[redacted]";
      continue;
    }
    try {
      result[sanitizeFixtureText(key)] = normalizeLoggerValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    } catch {
      result[sanitizeFixtureText(key)] = "[unreadable]";
    }
  }
  return result;
}

export function sanitizeFixtureText(value: string): string {
  const sanitized = value
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^\s/@]+:)([^@\s]+)(@)/gi,
      "$1[redacted]$3",
    )
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|authorization|auth|cookie|credential|api[_-]?key|x[_-]?api[_-]?key)=[^&#\s]*)/gi,
      (match) => `${match.slice(0, match.indexOf("=") + 1)}[redacted]`,
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /["']?(access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password|authorization|auth|cookie|credential|api[_-]?key|x[_-]?api[_-]?key)["']?\s*[:=]\s*["']?[^\s,;"'}]+["']?/gi,
      "$1=[redacted]",
    );
  return sanitized.length > maxLoggerStringLength
    ? `${sanitized.slice(0, maxLoggerStringLength)}...[truncated]`
    : sanitized;
}

export function validateOffscreenEvent(value: unknown): value is BridgeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  const common = ["kind", "runId", "participant", "sessionId", "sequence"];
  if (
    !isFixtureRunId(event.runId) ||
    event.participant !== "offscreen" ||
    !isFixtureSessionId(event.sessionId) ||
    typeof event.sequence !== "number" ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1
  )
    return false;
  return (
    (event.kind === "barrier" &&
      hasExactEventKeys(event, [...common, "name"]) &&
      isBoundedFixtureString(event.name)) ||
    ((event.kind === "result" || event.kind === "error") &&
      hasExactEventKeys(event, [...common, "value"]) &&
      isBoundedFixtureString(event.value))
  );
}

function hasExactEventKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

export function isFixtureRunId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
}

export function isFixtureSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isBoundedFixtureString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function fixtureErrorCode(error: unknown): string {
  try {
    if (
      error &&
      (typeof error === "object" || typeof error === "function") &&
      typeof (error as { code?: unknown }).code === "string"
    ) {
      return sanitizeFixtureText((error as { code: string }).code);
    }
  } catch {
    // Error objects may expose throwing accessors.
  }
  return "E_FIXTURE_UNKNOWN";
}

export function sanitizeFixtureError(error: unknown): string {
  try {
    if (
      error &&
      (typeof error === "object" || typeof error === "function") &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return sanitizeFixtureText((error as { message: string }).message);
    }
  } catch {
    // Error objects may expose throwing accessors.
  }
  return fixtureErrorCode(error);
}

export async function initializeBackgroundRun(runId: string): Promise<boolean> {
  if (!isFixtureRunId(runId)) return false;
  await chrome.storage.local.set({ [activeRunKey]: runId });
  return true;
}

export async function sendRunInit(
  runId: string,
  content?: {
    readonly label: string;
    readonly sessionId: string;
    readonly nonce: string;
  },
  ui?: {
    readonly participant: "popup" | "workspace";
    readonly sessionId: string;
  },
): Promise<void> {
  if (!isFixtureRunId(runId)) return;
  await chrome.runtime.sendMessage({
    kind: "run-init",
    runId,
    ...(content === undefined ? {} : { content }),
    ...(ui === undefined ? {} : { ui }),
  });
}

export function createReporter(
  identity: FixtureIdentity,
  onEvent?: (event: BridgeEvent) => void,
  sink?: (event: BridgeEvent) => Promise<void>,
) {
  const key = [identity.runId, identity.participant, identity.sessionId].join(
    ":",
  );
  const state = reporterStates.get(key) ?? {
    sequence: 0,
    writes: Promise.resolve(),
  };
  reporterStates.set(key, state);
  const createEvent = (
    kind: BridgeEvent["kind"],
    value: string,
  ): BridgeEvent =>
    kind === "barrier"
      ? {
          kind,
          runId: identity.runId,
          participant: identity.participant,
          sessionId: identity.sessionId,
          sequence: ++state.sequence,
          name: value,
        }
      : {
          kind,
          runId: identity.runId,
          participant: identity.participant,
          sessionId: identity.sessionId,
          sequence: ++state.sequence,
          value,
        };
  const persist = async (event: BridgeEvent): Promise<void> => {
    if (sink) {
      await sink(event);
    } else {
      await chrome.storage.session.set({ [eventKey(event)]: event });
    }
  };
  const report = async (
    kind: BridgeEvent["kind"],
    value: string,
  ): Promise<void> => {
    const event = createEvent(
      kind,
      kind === "barrier" || kind === "error"
        ? sanitizeFixtureText(value)
        : value,
    );
    const write = state.writes.then(async () => {
      await persist(event);
      onEvent?.(event);
    });
    // Keep later events writable when one browser storage operation rejects.
    state.writes = write.catch(() => undefined);
    await write;
  };
  const terminal = async (
    kind: "result" | "error",
    value: string,
    onCommandEvent?: (event: BridgeEvent) => void,
  ) => {
    const event = createEvent(
      kind,
      kind === "error" ? sanitizeFixtureText(value) : value,
    );
    // Terminal worker evidence is durable, while its active caller still needs
    // the correlated DOM reply.
    onCommandEvent?.(event);
    const write = persist(event);
    void write.catch(() => undefined);
  };
  const command = async (
    kind: "result" | "error",
    value: string,
    onCommandEvent?: (event: BridgeEvent) => void,
  ): Promise<void> => {
    const event = createEvent(
      kind,
      kind === "error" ? sanitizeFixtureText(value) : value,
    );
    // Direct command replies cross the realm through the command bridge, not
    // diagnostic storage. Independent events continue through report().
    onCommandEvent?.(event);
  };
  return {
    barrier: (name: string) => report("barrier", name),
    // Result callers emit controlled JSON-safe fixture values; do not rewrite them.
    result: (value: string) => report("result", value),
    error: (value: string) => report("error", value),
    commandReporter: (onCommandEvent: (event: BridgeEvent) => void) => ({
      result: (value: string) => command("result", value, onCommandEvent),
      error: (value: string) => command("error", value, onCommandEvent),
      terminalResult: (value: string) =>
        terminal("result", value, onCommandEvent),
    }),
    terminalResult: (value: string) => terminal("result", value),
  };
}

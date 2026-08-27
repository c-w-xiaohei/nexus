export type BridgeCommand = {
  readonly kind: "command";
  readonly runId: string;
  readonly command: string;
  readonly sequence: number;
};

export type BridgeResult = {
  readonly kind: "result" | "error";
  readonly runId: string;
  readonly command: string;
  readonly sequence: number;
  readonly participant: string;
  readonly sessionId: string;
  readonly value: string;
};

export type BridgeEvent =
  | {
      readonly kind: "barrier";
      readonly runId: string;
      readonly participant: string;
      readonly sessionId?: string;
      readonly sequence: number;
      readonly name: string;
    }
  | {
      readonly kind: "result" | "error";
      readonly runId: string;
      readonly participant: string;
      readonly sessionId?: string;
      readonly sequence: number;
      readonly value: string;
    };

export type DiagnosticEvent = BridgeEvent;

export const parseBridgeCommand = (
  value: unknown,
  runId: string,
  commands: readonly string[],
): BridgeCommand | undefined => {
  if (!isRecord(value) || value.kind !== "command" || value.runId !== runId) {
    return undefined;
  }
  if (
    typeof value.command !== "string" ||
    !commands.includes(value.command) ||
    !isPositiveInteger(value.sequence)
  ) {
    return undefined;
  }
  return {
    kind: "command",
    runId,
    command: value.command,
    sequence: value.sequence,
  };
};

export const parseBridgeResult = (
  value: unknown,
  expected: Pick<BridgeResult, "runId" | "command" | "sequence"> &
    Partial<Pick<BridgeResult, "participant" | "sessionId">>,
): BridgeResult | undefined => {
  if (!isRecord(value)) return undefined;
  if (
    (value.kind !== "result" && value.kind !== "error") ||
    value.runId !== expected.runId ||
    value.command !== expected.command ||
    value.sequence !== expected.sequence ||
    (expected.participant !== undefined &&
      value.participant !== expected.participant) ||
    (expected.sessionId !== undefined &&
      value.sessionId !== expected.sessionId) ||
    typeof value.participant !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.value !== "string"
  ) {
    return undefined;
  }
  return value as BridgeResult;
};

export const eventKey = (event: DiagnosticEvent): string =>
  [
    "nexus-e2e",
    event.runId,
    "event",
    event.participant,
    event.sessionId ?? "none",
    event.sequence,
  ].join(":");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

import { describe, expect, it } from "vitest";
import {
  BridgeCommand,
  DiagnosticEvent,
  eventKey,
  parseBridgeCommand,
  parseBridgeResult,
} from "../protocol";
import { Diagnostics } from "../harness/diagnostics";

describe("browser fixture protocol", () => {
  const command: BridgeCommand = {
    kind: "command",
    runId: "run-1",
    command: "probe",
    sequence: 1,
  };

  it("accepts only allowlisted command shapes for the active run", () => {
    expect(parseBridgeCommand(command, "run-1", ["probe"])).toEqual(command);
    expect(parseBridgeCommand(command, "other-run", ["probe"])).toBeUndefined();
    expect(parseBridgeCommand(command, "run-1", ["other"])).toBeUndefined();
    expect(
      parseBridgeCommand({ ...command, kind: "result" }, "run-1", ["probe"]),
    ).toBeUndefined();
    expect(
      parseBridgeCommand({ ...command, sequence: 0 }, "run-1", ["probe"]),
    ).toBeUndefined();
  });

  it("uses a collision-free event key for session and sequence", () => {
    const first = eventKey({
      kind: "barrier",
      runId: "run-1",
      participant: "content",
      sessionId: "main",
      sequence: 1,
      name: "ready",
    });
    const second = eventKey({
      kind: "barrier",
      runId: "run-1",
      participant: "content",
      sessionId: "child",
      sequence: 1,
      name: "ready",
    });

    expect(first).not.toBe(second);
  });

  it("requires optional participant and session correlation", () => {
    const result = {
      kind: "result",
      runId: "run-1",
      command: "probe",
      sequence: 1,
      participant: "content:alpha",
      sessionId: "session-alpha",
      value: "ok",
    } as const;

    expect(
      parseBridgeResult(result, {
        runId: "run-1",
        command: "probe",
        sequence: 1,
        participant: "content:alpha",
        sessionId: "session-alpha",
      }),
    ).toEqual(result);
    expect(
      parseBridgeResult(result, {
        runId: "run-1",
        command: "probe",
        sequence: 1,
        participant: "content:beta",
      }),
    ).toBeUndefined();
    expect(
      parseBridgeResult(result, {
        runId: "run-1",
        command: "probe",
        sequence: 1,
        sessionId: "session-beta",
      }),
    ).toBeUndefined();
  });

  it("rejects duplicate participant session sequences", () => {
    const events: DiagnosticEvent[] = [
      {
        kind: "barrier",
        runId: "run-1",
        participant: "content",
        sessionId: "main",
        sequence: 1,
        name: "ready",
      },
      {
        kind: "result",
        runId: "run-1",
        participant: "content",
        sessionId: "main",
        sequence: 1,
        value: "ready",
      },
    ];

    expect(() => Diagnostics.validate(events)).toThrow(
      "Duplicate diagnostic sequence",
    );
  });

  it("sorts diagnostics by participant, session, then sequence", () => {
    const events: DiagnosticEvent[] = [
      {
        kind: "result",
        runId: "run-1",
        participant: "content",
        sessionId: "main",
        sequence: 2,
        value: "second",
      },
      {
        kind: "barrier",
        runId: "run-1",
        participant: "background",
        sequence: 1,
        name: "ready",
      },
      {
        kind: "result",
        runId: "run-1",
        participant: "content",
        sessionId: "main",
        sequence: 1,
        value: "first",
      },
    ];

    expect(Diagnostics.sort(events).map((event) => event.sequence)).toEqual([
      1, 1, 2,
    ]);
    expect(Diagnostics.sort(events)[0]?.participant).toBe("background");
  });
});

import type { DiagnosticEvent } from "../protocol";

export namespace Diagnostics {
  export const validate = (events: readonly DiagnosticEvent[]): void => {
    const sequences = new Set<string>();
    for (const event of events) {
      if (
        !event.runId ||
        !event.participant ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1
      ) {
        throw new Error("Invalid diagnostic event shape");
      }
      const sequenceKey = [
        event.participant,
        event.sessionId ?? "none",
        event.sequence,
      ].join(":");
      if (sequences.has(sequenceKey)) {
        throw new Error(`Duplicate diagnostic sequence: ${sequenceKey}`);
      }
      sequences.add(sequenceKey);
    }
  };

  export const sort = (events: readonly DiagnosticEvent[]): DiagnosticEvent[] =>
    [...events].sort((left, right) => {
      const participant = left.participant.localeCompare(right.participant);
      if (participant !== 0) return participant;
      const session = (left.sessionId ?? "").localeCompare(
        right.sessionId ?? "",
      );
      if (session !== 0) return session;
      const sequence = left.sequence - right.sequence;
      if (sequence !== 0) return sequence;
      const kind = left.kind.localeCompare(right.kind);
      if (kind !== 0) return kind;
      return ("name" in left ? left.name : left.value).localeCompare(
        "name" in right ? right.name : right.value,
      );
    });
}

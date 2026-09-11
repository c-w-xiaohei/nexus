import { z } from "zod";
import { Result } from "better-result";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { NexusStoreProtocolError } from "./errors";
import type { ActionFunction, RemoteActions } from "./contract";

const snapshot = z.object({
  storeInstanceId: z.string(),
  version: z.number().int().nonnegative(),
  state: z.unknown(),
});
const callback = z.custom<(...args: any[]) => Promise<unknown>>(
  (value) => typeof value === "function",
);

// Capabilities travel in init, not subscribe's return value. Late init callbacks can
// still be rejected and cleaned up after the original acquisition has timed out.
export const InitEnvelopeSchema = snapshot.extend({
  type: z.literal("init"),
  actions: z.record(z.string(), callback),
  unsubscribe: callback,
});
export const SnapshotEnvelopeSchema = snapshot.extend({
  type: z.literal("snapshot"),
});
export const TerminalEnvelopeSchema = z.object({
  type: z.literal("terminal"),
  storeInstanceId: z.string(),
  lastKnownVersion: z.number().int().nonnegative(),
  reason: z.enum([
    "target-replaced",
    "target-changed",
    "provider-shutdown",
    "source-disconnected",
    "authorization-revoked",
  ]),
  error: z.unknown().optional(),
});
// Instance + version prevent stale providers and duplicate/out-of-order snapshots
// from silently overwriting a live mirror. Core handles the RPC, not this ordering.
export const SyncEnvelopeSchema = z.discriminatedUnion("type", [
  InitEnvelopeSchema,
  SnapshotEnvelopeSchema,
  TerminalEnvelopeSchema,
]);

export type SnapshotEnvelope<S = unknown> = Omit<
  z.infer<typeof SnapshotEnvelopeSchema>,
  "state"
> & { state: S };
export type TerminalEnvelope = z.infer<typeof TerminalEnvelopeSchema>;
export type TerminalReason = TerminalEnvelope["reason"];
export type InitEnvelope<S, A extends Record<string, ActionFunction>> = Omit<
  z.infer<typeof InitEnvelopeSchema>,
  "state" | "actions" | "unsubscribe"
> & {
  state: S;
  actions: RemoteActions<A>;
  unsubscribe(): void | Promise<void>;
};
export type SyncEnvelope<
  S = unknown,
  A extends Record<string, ActionFunction> = Record<string, ActionFunction>,
> = InitEnvelope<S, A> | SnapshotEnvelope<S> | TerminalEnvelope;

/** Preserves schema output and converts validation/getter throws at the boundary. */
export const safeParsePayload = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  message: string,
): Result<T, NexusStoreProtocolError> =>
  Result.try({
    try: () => ({ data: schema.parse(value) }),
    catch: (cause) => new NexusStoreProtocolError(message, { cause }),
  }).map(({ data }) => data);

export const safeValidateState = <TState extends object>(
  state: unknown,
  schema: z.ZodType<TState> | undefined,
  message: string,
): Result<TState, NexusStoreProtocolError> => {
  if (typeof state !== "object" || state === null)
    return Result.err(
      new NexusStoreProtocolError(message, {
        cause: new TypeError("State payload must be a non-null object."),
      }),
    );
  // A shared validator is not a normalization pipeline: every replica installs
  // the same wire state, even if the schema contains a transform or defaults.
  if (schema)
    return safeParsePayload(schema, state, message).map(() => state as TState);
  return Result.ok(state as TState);
};

/** Stops a subscription and releases callbacks, including partially valid init events. */
export function disposeSubscription(input: object): void {
  const event = input as { unsubscribe?: () => unknown; actions?: object };
  const release = (value: object | undefined) => {
    try {
      (value as { [RELEASE_PROXY_SYMBOL]?: () => void } | undefined)?.[
        RELEASE_PROXY_SYMBOL
      ]?.();
    } catch {
      /* The connection may already have reclaimed this capability. */
    }
  };
  try {
    const stop = event.unsubscribe;
    if (typeof stop === "function") {
      try {
        void Promise.resolve(stop()).catch(() => undefined);
      } finally {
        release(stop);
      }
    }
  } catch {
    /* Malformed unsubscribe must not retain the action callbacks. */
  }
  try {
    for (const action of Object.values(event.actions ?? {})) release(action);
  } catch {
    /* Malformed init may not contain all capabilities. */
  }
}

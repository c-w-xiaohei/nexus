import * as v from "valibot";
import { Result } from "better-result";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { NexusStoreProtocolError } from "./errors";
import type { RemoteActions } from "./contract";

const snapshotEntries = {
  storeInstanceId: v.string(),
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  state: v.unknown(),
};
const callback = v.custom<(...args: any[]) => Promise<unknown>>(
  (value) => typeof value === "function",
);

// Capabilities travel in init, not subscribe's return value. Late init callbacks can
// still be rejected and cleaned up after the original acquisition has timed out.
export const InitEnvelopeSchema = v.object({
  ...snapshotEntries,
  type: v.literal("init"),
  actions: v.record(v.string(), callback),
  unsubscribe: callback,
});
export const SnapshotEnvelopeSchema = v.object({
  ...snapshotEntries,
  type: v.literal("snapshot"),
});
export const TerminalEnvelopeSchema = v.object({
  type: v.literal("terminal"),
  storeInstanceId: v.string(),
  lastKnownVersion: v.pipe(v.number(), v.integer(), v.minValue(0)),
  reason: v.picklist([
    "target-replaced",
    "target-changed",
    "provider-shutdown",
    "source-disconnected",
    "authorization-revoked",
  ]),
  error: v.optional(v.unknown()),
});
// Instance + version prevent stale providers and duplicate/out-of-order snapshots
// from silently overwriting a live mirror. Core handles the RPC, not this ordering.
export const SyncEnvelopeSchema = v.variant("type", [
  InitEnvelopeSchema,
  SnapshotEnvelopeSchema,
  TerminalEnvelopeSchema,
]);

export type SnapshotEnvelope<S = unknown> = Omit<
  v.InferOutput<typeof SnapshotEnvelopeSchema>,
  "state"
> & { state: S };
export type TerminalEnvelope = v.InferOutput<typeof TerminalEnvelopeSchema>;
export type TerminalReason = TerminalEnvelope["reason"];
export type InitEnvelope<S, Store extends object> = Omit<
  v.InferOutput<typeof InitEnvelopeSchema>,
  "state" | "actions" | "unsubscribe"
> & {
  state: S;
  actions: RemoteActions<Store>;
  unsubscribe(): void | Promise<void>;
};
export type SyncEnvelope<S = unknown, Store extends object = object> =
  | InitEnvelope<S, Store>
  | SnapshotEnvelope<S>
  | TerminalEnvelope;

/** Parses framework-owned values and preserves Valibot's parsed output. */
export const safeParsePayload = <T>(
  schema: v.GenericSchema<unknown, T>,
  value: unknown,
  message: string,
): Result<T, NexusStoreProtocolError> =>
  Result.try({
    try: () => {
      const parsed = v.safeParse(schema, value);
      if (!parsed.success) throw new TypeError("Schema validation failed.");
      // Box outputs so Result.try does not treat a Promise-valued payload as
      // asynchronous parsing.
      return { data: parsed.output };
    },
    catch: (cause) => new NexusStoreProtocolError(message, { cause }),
  }).map(({ data }) => data);

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;

/**
 * Runs synchronous Standard Schema validation at the State boundary.
 * Output compatibility does not prove the raw input type; async results are
 * rejected at runtime and their promises are consumed.
 */
export const safeValidateValue = <Output>(
  value: unknown,
  schema: StandardSchemaV1<unknown, Output>,
  message: string,
): Result<Output, NexusStoreProtocolError> => {
  try {
    const candidate = schema["~standard"].validate(value);
    if (isPromiseLike(candidate)) {
      void Promise.resolve(candidate).catch(() => undefined);
      throw new TypeError("Asynchronous State validation is not supported.");
    }
    const result = candidate as StandardSchemaV1.Result<Output>;
    if (result.issues) throw new TypeError("State validation failed.");
    return Result.ok(result.value);
  } catch (cause) {
    return Result.err(new NexusStoreProtocolError(message, { cause }));
  }
};

/** Validate object-shaped state without replacing the received wire value. */
export const safeValidateState = <TState extends object>(
  state: unknown,
  schema: StandardSchemaV1<unknown, TState> | undefined,
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
    return safeValidateValue(state, schema, message).map(() => state as TState);
  return Result.ok(state as TState);
};

/** Stops a subscription and releases callbacks, including partially valid init events. */
export function disposeSubscription(input: object): Promise<void> {
  const event = input as { unsubscribe?: () => unknown; actions?: object };
  /** Release a remote capability without allowing one failure to block cleanup. */
  const release = (value: object | undefined) => {
    try {
      (value as { [RELEASE_PROXY_SYMBOL]?: () => void } | undefined)?.[
        RELEASE_PROXY_SYMBOL
      ]?.();
    } catch {
      /* The connection may already have reclaimed this capability. */
    }
  };
  let completed = Promise.resolve();
  try {
    const stop = event.unsubscribe;
    if (typeof stop === "function") {
      // Lazy remote callbacks do not start until the thenable is consumed. Keep
      // the capability alive until that invocation has been observed.
      try {
        const result = stop();
        if (result && typeof result === "object" && "then" in result) {
          completed = Promise.resolve(result)
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => release(stop));
        } else {
          release(stop);
        }
      } catch {
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
  return completed;
}

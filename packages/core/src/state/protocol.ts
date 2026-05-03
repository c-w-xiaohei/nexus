import { z } from "zod";
import { TargetCriteriaSchema } from "./target-schema";

export const SubscribeResultSchema = z.object({
  storeInstanceId: z.string(),
  subscriptionId: z.string(),
  version: z.number().int().nonnegative(),
  state: z.unknown(),
});

export const SnapshotEnvelopeSchema = z.object({
  type: z.literal("snapshot"),
  storeInstanceId: z.string(),
  version: z.number().int().nonnegative(),
  state: z.unknown(),
});

export const TerminalReasonSchema = z.enum([
  "target-replaced",
  "target-changed",
  "provider-shutdown",
  "source-disconnected",
  "authorization-revoked",
]);

export const TerminalEnvelopeSchema = z.object({
  type: z.literal("terminal"),
  storeInstanceId: z.string(),
  lastKnownVersion: z.number().int().nonnegative(),
  reason: TerminalReasonSchema,
  error: z.unknown().optional(),
});

export const SyncEnvelopeSchema = z.union([
  SnapshotEnvelopeSchema,
  TerminalEnvelopeSchema,
]);

export const DispatchRequestEnvelopeSchema = z.object({
  type: z.literal("dispatch-request"),
  action: z.string().min(1),
  args: z.array(z.unknown()),
});

export const DispatchResultEnvelopeSchema = z.object({
  type: z.literal("dispatch-result"),
  committedVersion: z.number().int().nonnegative(),
  result: z.unknown(),
});

export const ConnectNexusStoreOptionsSchema = z.object({
  target: TargetCriteriaSchema.optional(),
  timeout: z.number().nonnegative().optional(),
});

export type SubscribeResult = z.infer<typeof SubscribeResultSchema>;
export type SnapshotEnvelope = z.infer<typeof SnapshotEnvelopeSchema>;
export type TerminalReason = z.infer<typeof TerminalReasonSchema>;
export type TerminalEnvelope = z.infer<typeof TerminalEnvelopeSchema>;
export type SyncEnvelope = z.infer<typeof SyncEnvelopeSchema>;
export type DispatchRequestEnvelope = z.infer<
  typeof DispatchRequestEnvelopeSchema
>;
export type DispatchResultEnvelope = z.infer<
  typeof DispatchResultEnvelopeSchema
>;
export type ConnectNexusStoreOptionsInput = z.infer<
  typeof ConnectNexusStoreOptionsSchema
>;

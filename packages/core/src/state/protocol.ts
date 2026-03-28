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
export type DispatchRequestEnvelope = z.infer<
  typeof DispatchRequestEnvelopeSchema
>;
export type DispatchResultEnvelope = z.infer<
  typeof DispatchResultEnvelopeSchema
>;
export type ConnectNexusStoreOptionsInput = z.infer<
  typeof ConnectNexusStoreOptionsSchema
>;

import { z } from "zod";

const targetDescriptorSchema = z.union([
  z.string(),
  z.custom<Record<string, unknown>>(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
]);

const targetMatcherSchema = z.union([
  z.string(),
  z.custom<(identity: unknown) => boolean>(
    (value) => typeof value === "function",
  ),
]);

export const createTargetCriteriaSchema = (message: string) =>
  z
    .object({
      descriptor: targetDescriptorSchema.optional(),
      matcher: targetMatcherSchema.optional(),
    })
    .refine(
      (input) =>
        typeof input.descriptor !== "undefined" ||
        typeof input.matcher !== "undefined",
      {
        message,
      },
    );

export const TargetCriteriaSchema = createTargetCriteriaSchema(
  "target requires at least one of descriptor or matcher",
);

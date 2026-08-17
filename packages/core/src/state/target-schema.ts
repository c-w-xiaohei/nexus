import { z } from "zod";

export const ConnectionTargetSchema = z.custom<object>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
);

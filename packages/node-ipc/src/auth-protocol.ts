import { literal, looseObject, string, type InferOutput } from "valibot";

export const AuthRequestSchema = looseObject({
  type: literal("nexus-ipc-auth"),
  version: literal(1),
  token: string(),
});

export const AuthAckSchema = looseObject({
  type: literal("nexus-ipc-auth-ok"),
});

export type AuthRequest = InferOutput<typeof AuthRequestSchema>;
export type AuthAck = InferOutput<typeof AuthAckSchema>;

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { VirtualPortProtocolError } from "./errors";

export namespace VirtualPortProtocol {
  export const MARKER = "__nexusVirtualPort";
  export const VERSION = 1;

  const BaseMessageSchema = z
    .object({
      [MARKER]: z.literal(true),
      version: z.literal(VERSION),
      channelId: z.string().min(1),
      from: z.string().min(1),
      nonce: z.string().min(1),
    })
    .strict();

  export const ConnectMessageSchema = BaseMessageSchema.extend({
    type: z.literal("connect"),
  }).strict();

  export const AcceptMessageSchema = BaseMessageSchema.extend({
    type: z.literal("accept"),
  }).strict();

  export const RejectMessageSchema = BaseMessageSchema.extend({
    type: z.literal("reject"),
    reason: z.string().optional(),
  }).strict();

  export const DataMessageSchema = BaseMessageSchema.extend({
    type: z.literal("data"),
    seq: z.number().int().nonnegative(),
    payload: z.unknown(),
  }).strict();

  export const CloseMessageSchema = BaseMessageSchema.extend({
    type: z.literal("close"),
  }).strict();

  export const PingMessageSchema = BaseMessageSchema.extend({
    type: z.literal("ping"),
  }).strict();

  export const PongMessageSchema = BaseMessageSchema.extend({
    type: z.literal("pong"),
  }).strict();

  export const MessageSchema = z.discriminatedUnion("type", [
    ConnectMessageSchema,
    AcceptMessageSchema,
    RejectMessageSchema,
    DataMessageSchema,
    CloseMessageSchema,
    PingMessageSchema,
    PongMessageSchema,
  ]);

  export type Message = z.infer<typeof MessageSchema>;
  export type DataMessage = z.infer<typeof DataMessageSchema>;

  export const safeClassify = (
    message: unknown,
  ): Result<Message, VirtualPortProtocolError> => {
    const result = MessageSchema.safeParse(message);
    if (!result.success) {
      return err(
        new VirtualPortProtocolError("Invalid virtual port message", {
          issues: result.error.issues,
        }),
      );
    }

    return ok(result.data);
  };

  export const createBase = (input: {
    channelId: string;
    from: string;
    nonce: string;
  }) => ({
    [MARKER]: true as const,
    version: VERSION as typeof VERSION,
    channelId: input.channelId,
    from: input.from,
    nonce: input.nonce,
  });
}

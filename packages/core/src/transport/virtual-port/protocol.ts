import { Result } from "better-result";
const { err, ok } = Result;
import {
  integer,
  literal,
  minLength,
  minValue,
  number,
  optional,
  pipe,
  safeParse,
  strictObject,
  string,
  unknown,
  variant,
  type InferOutput,
} from "valibot";
import { VirtualPortProtocolError } from "./errors.js";

export namespace VirtualPortProtocol {
  export const MARKER = "__nexusVirtualPort";
  export const VERSION = 1;

  const BaseMessageEntries = {
    [MARKER]: literal(true),
    version: literal(VERSION),
    channelId: pipe(string(), minLength(1)),
    from: pipe(string(), minLength(1)),
    nonce: pipe(string(), minLength(1)),
  };

  export const ConnectMessageSchema = strictObject({
    ...BaseMessageEntries,
    type: literal("connect"),
  });

  export const AcceptMessageSchema = strictObject({
    ...BaseMessageEntries,
    type: literal("accept"),
  });

  export const RejectMessageSchema = strictObject({
    ...BaseMessageEntries,
    type: literal("reject"),
    reason: optional(string()),
  });

  export const DataMessageSchema = strictObject({
    ...BaseMessageEntries,
    type: literal("data"),
    seq: pipe(number(), integer(), minValue(0)),
    payload: unknown(),
  });

  export const CloseMessageSchema = strictObject({
    ...BaseMessageEntries,
    type: literal("close"),
  });

  export const PingMessageSchema = strictObject({
    ...BaseMessageEntries,
    type: literal("ping"),
  });

  export const PongMessageSchema = strictObject({
    ...BaseMessageEntries,
    type: literal("pong"),
  });

  export const MessageSchema = variant("type", [
    ConnectMessageSchema,
    AcceptMessageSchema,
    RejectMessageSchema,
    DataMessageSchema,
    CloseMessageSchema,
    PingMessageSchema,
    PongMessageSchema,
  ]);

  export type Message = InferOutput<typeof MessageSchema>;
  export type DataMessage = InferOutput<typeof DataMessageSchema>;

  export const safeClassify = (
    message: unknown,
  ): Result<Message, VirtualPortProtocolError> => {
    let result;
    try {
      result = safeParse(MessageSchema, message);
    } catch (cause) {
      return err(
        new VirtualPortProtocolError("Invalid virtual port message", {
          issues: [],
          cause,
        }),
      );
    }
    if (!result.success) {
      return err(
        new VirtualPortProtocolError("Invalid virtual port message", {
          issues: result.issues,
        }),
      );
    }

    // Validate the envelope, but return the wire value unchanged so opaque
    // payloads and their transfer/reference identity are not rewritten.
    return ok(message as Message);
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

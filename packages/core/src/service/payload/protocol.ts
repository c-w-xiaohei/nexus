/**
 * The single source of truth for the Nexus JSON-based payload protocol.
 * This defines the special placeholder format used to encode non-serializable
 * JavaScript types into strings.
 */

/**
 * The prefix for all Nexus placeholders. Chosen from the "private use"
 * unicode block to minimize collision with user data.
 */
export const PLACEHOLDER_PREFIX = "\u0003";

/**
 * The character used to escape user data that happens to start with
 * the PLACEHOLDER_PREFIX or the ESCAPE_CHAR itself.
 */
export const ESCAPE_CHAR = "\u0004";

/**
 * The separator between the placeholder type code and its payload.
 */
export const PAYLOAD_SEPARATOR = ":";

/**
 * An enumeration of all special types that can be represented as placeholders.
 * The single-character codes are used for maximum compression.
 */
export enum PlaceholderType {
  RESOURCE = "R", // Represents a function or @Ref object proxy
  UNDEFINED = "U",
  MAP = "M",
  SET = "S",
  BIGINT = "N",
  // The following are not yet in the spec, but good to have placeholders for
  // DATE = 'D',
  // REGEXP = 'X',
}

import type { UserMetadata, PlatformMetadata } from "@/types/identity";
import {
  LocalResourceType,
  type ReviveContext,
  type SanitizeContext,
  ValueType,
} from "../types";
import { Placeholder } from "./placeholder";
import { PayloadProcessor } from "./payload-processor";

type SanitizeHandler<U extends UserMetadata, P extends PlatformMetadata> = (
  processor: PayloadProcessor.Runtime<U, P>,
  value: any,
  context: SanitizeContext,
) => Placeholder;

type ReviveHandler<U extends UserMetadata, P extends PlatformMetadata> = (
  processor: PayloadProcessor.Runtime<U, P>,
  placeholder: Placeholder,
  context: ReviveContext,
) => any;

export const SANITIZER_TABLE_CONFIG = new Map<
  ValueType,
  SanitizeHandler<any, any>
>([
  [
    ValueType.FUNCTION,
    (processor, value, context) => {
      const resourceId = processor.resourceManager.registerLocalResource(
        value,
        context.targetConnectionId,
        LocalResourceType.FUNCTION,
      );
      return new Placeholder(PlaceholderType.RESOURCE, resourceId);
    },
  ],
  [
    ValueType.MAP,
    (_, value) =>
      new Placeholder(
        PlaceholderType.MAP,
        JSON.stringify(Array.from(value.entries())),
      ),
  ],
  [
    ValueType.SET,
    (_, value) =>
      new Placeholder(
        PlaceholderType.SET,
        JSON.stringify(Array.from(value.values())),
      ),
  ],
  [
    ValueType.BIGINT,
    (_, value) => new Placeholder(PlaceholderType.BIGINT, value.toString()),
  ],
]);

export const REVIVER_TABLE_CONFIG = new Map<
  PlaceholderType,
  ReviveHandler<any, any>
>([
  [
    PlaceholderType.RESOURCE,
    (processor, placeholder, context) =>
      processor.proxyFactory.createRemoteResourceProxy(
        placeholder.payload!,
        context.sourceConnectionId,
      ),
  ],
  [
    PlaceholderType.MAP,
    (_, placeholder) => new Map(JSON.parse(placeholder.payload!)),
  ],
  [
    PlaceholderType.SET,
    (_, placeholder) => new Set(JSON.parse(placeholder.payload!)),
  ],
  [PlaceholderType.BIGINT, (_, placeholder) => BigInt(placeholder.payload!)],
  [PlaceholderType.UNDEFINED, () => undefined],
]);

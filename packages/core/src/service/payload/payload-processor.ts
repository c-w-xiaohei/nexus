import type { PlatformMetadata, UserMetadata } from "../../types/identity";
import {
  getValueType,
  LocalResourceType,
  type ReviveContext,
  type SanitizeContext,
  ValueType,
} from "../types";
import type { ProxyFactory } from "../proxy-factory";
import type { ResourceManager } from "../resource-manager";
import { isRefWrapper } from "@/types/ref-wrapper";
import { Placeholder } from "./placeholder";
import {
  ESCAPE_CHAR,
  PLACEHOLDER_PREFIX,
  PlaceholderType,
  REVIVER_TABLE_CONFIG,
  SANITIZER_TABLE_CONFIG,
} from "./protocol";
import { Logger } from "@/logger";

/**
 * Handles the "magic" of Nexus: sanitizing and reviving payloads.
 * It translates between local objects/functions and their serializable
 * placeholder representations for transport.
 */
export class PayloadProcessor<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  private readonly logger = new Logger("L3 --- PayloadProcessor");
  constructor(
    // Dependencies are injected by the Engine.
    public readonly resourceManager: ResourceManager,
    public readonly proxyFactory: ProxyFactory<U, P>
  ) {}

  /**
   * Scans a payload for functions or `@Ref` objects and replaces them
   * with a resource placeholder. This is called before sending a message.
   * @param args The original arguments for a call or result.
   * @param targetConnectionId The ID of the connection the message will be sent to.
   * @returns A new array with resources replaced by placeholders.
   */
  public sanitize(args: any[], targetConnectionId: string): any[] {
    // In a real implementation, @Ref metadata would be passed alongside args
    return this.internalSanitize(args, { targetConnectionId }) as any[];
  }

  /**
   * Scans a received argument list for resource placeholders and replaces them
   * with newly created local proxy objects.
   * @param args The received arguments containing placeholders.
   * @param sourceConnectionId The ID of the connection the message came from.
   * @returns A new array with placeholders replaced by live proxies.
   */
  public revive(args: any[], sourceConnectionId: string): any[] {
    return this.internalRevive(args, { sourceConnectionId }) as any[];
  }

  private internalSanitize(value: any, context: SanitizeContext): any {
    // 1. Handle explicit ref wrappers first (pass by reference)
    if (isRefWrapper(value)) {
      const resourceId = this.resourceManager.registerLocalResource(
        value.target,
        context.targetConnectionId,
        LocalResourceType.OBJECT
      );
      this.logger.debug(
        `-> Sanitized nexus.ref() object by creating local resource #${resourceId}.`
      );
      return new Placeholder(PlaceholderType.RESOURCE, resourceId).toString();
    }

    // This is the fundamental fix. We robustly check for plain objects
    // and serialize them by value, BEFORE falling back to `getValueType`.
    // This prevents them from being misidentified as complex objects
    // to be passed by reference.
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      const result: { [key: string]: any } = {};
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          result[key] = this.internalSanitize(value[key], context);
        }
      }
      return result;
    }

    const type = getValueType(value);

    // 2. Handle primitives and undefined (pass by value)
    if (type === ValueType.PRIMITIVE) {
      if (typeof value === "undefined") {
        return new Placeholder(PlaceholderType.UNDEFINED).toString();
      }
      // Escape user strings that might conflict with our protocol
      if (typeof value === "string") {
        if (
          value.startsWith(PLACEHOLDER_PREFIX) ||
          value.startsWith(ESCAPE_CHAR)
        ) {
          return `${ESCAPE_CHAR}${value}`;
        }
      }
      return value;
    }

    // 3. Recurse for arrays (pass by value, recursively)
    if (type === ValueType.ARRAY) {
      return value.map((item: any) => this.internalSanitize(item, context));
    }

    // 4. Recurse for plain objects (pass by value, recursively) - THIS BLOCK IS NOW REDUNDANT
    if (type === ValueType.PLAIN_OBJECT) {
      const result: { [key: string]: any } = {};
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          result[key] = this.internalSanitize(value[key], context);
        }
      }
      return result;
    }

    // 5. Use the sanitizer table for other special types (e.g., functions -> pass by reference)
    const handler = SANITIZER_TABLE_CONFIG.get(type);
    if (handler) {
      return handler(this, value, context).toString();
    }

    // 6. For any other unhandled case, throw an error to prevent silent data corruption.
    this.logger.error(
      `Nexus serialization error: Unsupported type for value.`,
      value
    );
    throw new Error(
      `Nexus serialization error: Unsupported type "${typeof value}"`
    );
  }

  private internalRevive(value: any, context: ReviveContext): any {
    // 1. Check for our own escaped user strings first.
    if (typeof value === "string" && value.startsWith(ESCAPE_CHAR)) {
      // This is user data that was escaped. Return the original string.
      return value.substring(ESCAPE_CHAR.length);
    }

    // 2. Attempt to parse as a placeholder. This must come after the escape check.
    const placeholder = Placeholder.fromString(value);
    if (placeholder) {
      this.logger.debug(
        `<- Reviving placeholder for resource #${placeholder.payload} from connection ${context.sourceConnectionId}.`,
        placeholder
      );
      const handler = REVIVER_TABLE_CONFIG.get(placeholder.type);
      if (handler) {
        return handler(this, placeholder, context);
      }
      // This case should ideally not be reached if sanitizer is correct
      console.warn(
        `Nexus reviver: No handler for placeholder type "${placeholder.type}"`
      );
      this.logger.warn(
        `No reviver handler for placeholder type "${placeholder.type}". Returning as is.`,
        placeholder
      );
      return value; // Return as is if no handler found
    }

    // 3. If not an escaped string and not a placeholder, recurse for collections.
    if (Array.isArray(value)) {
      return value.map((item: any) => this.internalRevive(item, context));
    }

    if (value !== null && typeof value === "object") {
      const result: { [key: string]: any } = {};
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          result[key] = this.internalRevive(value[key], context);
        }
      }
      return result;
    }

    // 4. If none of the above, it's a primitive value (that didn't need escaping).
    return value;
  }
}

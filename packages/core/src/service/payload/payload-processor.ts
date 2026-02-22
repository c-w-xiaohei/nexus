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
import { Result, err, ok, type Result as TResult } from "neverthrow";

export namespace PayloadProcessor {
  type ErrorCode = "E_PROTOCOL_ERROR";

  type ErrorOptions = {
    readonly context?: Record<string, unknown>;
  };

  class UnsupportedTypeError extends globalThis.Error {
    readonly code: ErrorCode = "E_PROTOCOL_ERROR";
    readonly context?: Record<string, unknown>;

    constructor(message: string, options: ErrorOptions = {}) {
      super(message);
      this.name = "PayloadProcessorUnsupportedTypeError";
      this.context = options.context;
    }
  }

  export const Error = {
    UnsupportedType: UnsupportedTypeError,
  } as const;

  export interface Runtime<
    U extends UserMetadata,
    _P extends PlatformMetadata,
  > {
    readonly resourceManager: ResourceManager.Runtime;
    readonly proxyFactory: ProxyFactory<U>;
    safeSanitize(
      args: any[],
      targetConnectionId: string,
    ): TResult<any[], globalThis.Error>;
    safeRevive(
      args: any[],
      sourceConnectionId: string,
    ): TResult<any[], globalThis.Error>;
  }

  export const create = <U extends UserMetadata, P extends PlatformMetadata>(
    resourceManager: ResourceManager.Runtime,
    proxyFactory: ProxyFactory<U>,
  ): Runtime<U, P> => {
    const logger = new Logger("L3 --- PayloadProcessor");

    const internalSanitize = (value: any, context: SanitizeContext): any => {
      if (isRefWrapper(value)) {
        const resourceId = resourceManager.registerLocalResource(
          value.target,
          context.targetConnectionId,
          LocalResourceType.OBJECT,
        );
        logger.debug(
          `-> Sanitized nexus.ref() object by creating local resource #${resourceId}.`,
        );
        return new Placeholder(PlaceholderType.RESOURCE, resourceId).toString();
      }

      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
      ) {
        const result: { [key: string]: any } = {};
        for (const key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            result[key] = internalSanitize(value[key], context);
          }
        }
        return result;
      }

      const type = getValueType(value);

      if (type === ValueType.PRIMITIVE) {
        if (typeof value === "undefined") {
          return new Placeholder(PlaceholderType.UNDEFINED).toString();
        }
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

      if (type === ValueType.ARRAY) {
        return value.map((item: any) => internalSanitize(item, context));
      }

      if (type === ValueType.PLAIN_OBJECT) {
        const result: { [key: string]: any } = {};
        for (const key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            result[key] = internalSanitize(value[key], context);
          }
        }
        return result;
      }

      const handler = SANITIZER_TABLE_CONFIG.get(type);
      if (handler) {
        return handler(runtime as Runtime<any, any>, value, context).toString();
      }

      logger.error(
        `Nexus serialization error: Unsupported type for value.`,
        value,
      );
      throw new Error.UnsupportedType(
        `Nexus serialization error: Unsupported type "${typeof value}"`,
        { context: { valueType: typeof value } },
      );
    };

    const internalRevive = (value: any, context: ReviveContext): any => {
      if (typeof value === "string" && value.startsWith(ESCAPE_CHAR)) {
        return value.substring(ESCAPE_CHAR.length);
      }

      const placeholder = Placeholder.fromString(value);
      if (placeholder) {
        logger.debug(
          `<- Reviving placeholder for resource #${placeholder.payload} from connection ${context.sourceConnectionId}.`,
          placeholder,
        );
        const handler = REVIVER_TABLE_CONFIG.get(placeholder.type);
        if (handler) {
          return handler(runtime as Runtime<any, any>, placeholder, context);
        }
        logger.warn(
          `No reviver handler for placeholder type "${placeholder.type}". Returning as is.`,
          placeholder,
        );
        return value;
      }

      if (Array.isArray(value)) {
        return value.map((item: any) => internalRevive(item, context));
      }

      if (value !== null && typeof value === "object") {
        const result: { [key: string]: any } = {};
        for (const key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            result[key] = internalRevive(value[key], context);
          }
        }
        return result;
      }

      return value;
    };

    const safeSanitize = (
      args: any[],
      targetConnectionId: string,
    ): TResult<any[], globalThis.Error> => {
      const result = Result.fromThrowable(
        () => {
          const sanitized = internalSanitize(args, { targetConnectionId });
          return Array.isArray(sanitized) ? sanitized : [sanitized];
        },
        (error) =>
          error instanceof globalThis.Error
            ? error
            : new Error.UnsupportedType(
                `Nexus serialization error: ${String(error)}`,
                { context: { targetConnectionId } },
              ),
      )();

      if (result.isErr()) {
        return err(result.error);
      }

      return ok(result.value);
    };

    const safeRevive = (
      args: any[],
      sourceConnectionId: string,
    ): TResult<any[], globalThis.Error> => {
      const result = Result.fromThrowable(
        () => {
          const revived = internalRevive(args, { sourceConnectionId });
          return Array.isArray(revived) ? revived : [revived];
        },
        (error) =>
          error instanceof globalThis.Error
            ? error
            : new Error.UnsupportedType(
                `Nexus revive error: ${String(error)}`,
                { context: { sourceConnectionId } },
              ),
      )();

      if (result.isErr()) {
        return err(result.error);
      }

      return ok(result.value);
    };

    const runtime: Runtime<U, P> = {
      resourceManager,
      proxyFactory,
      safeSanitize,
      safeRevive,
    };

    return runtime;
  };
}

/**
 * This barrel file will export all types and interfaces specific to Layer 3.
 */

import type { UserMetadata, PlatformMetadata } from "../../types/identity";
import type { MessageId, NexusMessage } from "../../types/message";

/**
 * The type of a locally held resource that is exposed to remote contexts.
 * - `function`: A standard function or a method.
 * - `object`: An object passed by reference, typically marked with `@Ref`.
 */
export enum LocalResourceType {
  FUNCTION = "function",
  OBJECT = "ref_object",
}

/**
 * A record for a resource that exists in the local context and has been
 * made available for remote access via a resource ID.
 */
export interface LocalResourceRecord {
  /** The actual object or function being exposed. */
  target: object;
  /** The ID of the connection that "owns" the proxy to this resource. */
  ownerConnectionId: string;
  /** The type of the resource. */
  type: LocalResourceType;
}

/**
 * A record for a proxy object that exists in the local context and represents
 * a resource in a remote context.
 */
export interface RemoteProxyRecord {
  /** The local proxy object that forwards calls to the remote resource. */
  proxy: object;
  /** The ID of the connection from which this resource originates. */
  sourceConnectionId: string;
}

/**
 * Represents a pending remote call that is waiting for a response.
 */
export interface PendingCall {
  /** The function to call to resolve the promise associated with this call. */
  resolve: (value: any) => void;
  /** The function to call to reject the promise associated with this call. */
  reject: (reason?: any) => void;
  /** An optional timeout timer for the call. */
  timer?: NodeJS.Timeout;
}

export interface ExposedService<T> {
  instance: T;
  // TODO: Add options like `isSingleton` etc.
}

/**
 * Represents a local resource that has been passed by reference to a remote
 * context.
 */
export interface LocalResource {
  type: LocalResourceType;
  target: object; // The actual function or object
  ownerConnectionIds: Set<string>; // Which connections have a proxy to this
  cleanup: () => void; // The cleanup function from FinalizationRegistry
}

/**
 * Represents a remote resource for which a local proxy has been created.
 */
export interface RemoteProxy {
  proxy: object; // The actual proxy object
  sourceConnectionId: string; // The connection this proxy belongs to
}

/** Context for sanitizing payloads before sending. */
export interface SanitizeContext {
  targetConnectionId: string;
  /** Indicates if the value is explicitly marked with @Ref */
  isRef?: boolean;
}

/** Context for reviving payloads after receiving. */
export interface ReviveContext {
  sourceConnectionId: string;
}

/** Enum to classify JS values for the sanitizer table */
export enum ValueType {
  PRIMITIVE,
  FUNCTION,
  MAP,
  SET,
  BIGINT,
  PLAIN_OBJECT,
  ARRAY,
}

/** Helper to classify values for sanitization */
export function getValueType(value: any): ValueType {
  const type = typeof value;
  if (
    value === null ||
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "undefined"
  ) {
    return ValueType.PRIMITIVE;
  }
  if (type === "bigint") return ValueType.BIGINT;
  if (type === "function") return ValueType.FUNCTION;
  if (value instanceof Map) return ValueType.MAP;
  if (value instanceof Set) return ValueType.SET;
  if (Array.isArray(value)) return ValueType.ARRAY;
  // Treat all other objects (including class instances) as plain objects for serialization.
  // This means their prototype chain will be lost.
  if (type === "object") {
    return ValueType.PLAIN_OBJECT;
  }
  // Fallback for any other unhandled type
  return ValueType.PRIMITIVE;
}

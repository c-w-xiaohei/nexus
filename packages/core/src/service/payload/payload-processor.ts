import type { AdapterModel } from "@/types/adapter-model";
import { remoteBinding, type ProxyFactory } from "../proxy-factory";
import type { ResourceManager } from "../resource-manager";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import { isRefWrapper } from "@/types/ref-wrapper";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { Placeholder } from "./placeholder";
import {
  ESCAPE_CHAR,
  PLACEHOLDER_PREFIX,
  PlaceholderType,
  REVIVER_TABLE_CONFIG,
  validateResourceId,
} from "./protocol";
import { Logger } from "@/logger";
import { Result } from "better-result";
import { toFrameworkProtocolError } from "@/errors";
import { scopeClosedError, type ResourceScope } from "../resource-scope";
import {
  createBinaryValue,
  decodeBinaryValue,
  isBinaryValue,
} from "./binary-value";
import {
  createByteReservationLease,
  type ByteReservationBudget,
  type ByteReservationLease,
} from "./byte-reservation";
import { DEFAULT_TRANSPORT_LIMITS } from "@/transport/transport-config";

export interface PayloadReservationOptions extends ByteReservationBudget {
  readonly signal?: AbortSignal;
  /** Receives retained ownership after successful preparation. */
  readonly onLease: (lease: ByteReservationLease) => void;
}

type RevivalContext = {
  scope?: ResourceScope;
  sourceConnectionId: string;
  callTimeout?: number;
  revived: Map<string, { proxy: object; existedBeforeRevive: boolean }>;
};
type SanitizeContext = {
  scope?: ResourceScope;
  targetConnectionId: string;
  createdResourceIds: string[];
  serviceName?: string;
  servicePolicy?: NexusAuthorizationPolicy<AdapterModel>;
};

type SanitizeBudget = {
  nodes: number;
  textBytes: number;
  rawBytes: number;
  lease: ByteReservationLease;
  signal?: AbortSignal;
};

const MAX_PAYLOAD_DEPTH = 128;
const MAX_PAYLOAD_NODES = 100_000;

/** Transactional payload conversion for one Engine, with session-owned capabilities. */
export class PayloadProcessor {
  private readonly logger = new Logger("L3 --- PayloadProcessor");
  /** Shares the Engine's capability registry and proxy factory across independent payload transactions. */
  constructor(
    readonly resourceManager: ResourceManager,
    readonly proxyFactory: ProxyFactory,
  ) {}

  /** Encodes arguments for one session, rolling back newly registered capabilities on failure. */
  public safeSanitize(
    args: any[],
    targetConnectionId: string,
    scope?: ResourceScope,
    reservation?: PayloadReservationOptions,
  ): Promise<Result<any[], Error>> {
    return this.safeSanitizeWithContext(
      args,
      { targetConnectionId, scope },
      reservation,
    );
  }

  /** Encodes results with the exact authorized policy, including an explicit undefined snapshot. */
  public safeSanitizeFromService(
    args: any[],
    targetConnectionId: string,
    serviceName: string,
    servicePolicy: NexusAuthorizationPolicy<AdapterModel> | undefined,
    scope?: ResourceScope,
    reservation?: PayloadReservationOptions,
  ): Promise<Result<any[], Error>> {
    return this.safeSanitizeWithContext(
      args,
      {
        targetConnectionId,
        serviceName,
        servicePolicy,
        scope,
      },
      reservation,
    );
  }

  /** Revives one payload; failed conversion discards new facades without releasing older identities. */
  public safeRevive(
    args: any[],
    sourceConnectionId: string,
    callTimeout?: number,
    scope?: ResourceScope,
  ): Result<any[], Error> {
    const context: RevivalContext = {
      sourceConnectionId,
      callTimeout,
      scope,
      revived: new Map(),
    };
    const result = Result.try({
      try: () => {
        const revived = this.revive(args, context);
        return Array.isArray(revived) ? revived : [revived];
      },
      catch: toFrameworkProtocolError,
    });
    if (result.isErr()) {
      for (const { proxy, existedBeforeRevive } of context.revived.values()) {
        if (existedBeforeRevive)
          this.proxyFactory.discardRemoteResourceProxy(proxy);
        else {
          const release = (proxy as { [RELEASE_PROXY_SYMBOL]?: unknown })[
            RELEASE_PROXY_SYMBOL
          ];
          if (typeof release === "function") release();
        }
      }
    }
    return result;
  }

  /** Releases local capabilities encoded for an unaccepted handoff. */
  public releaseSanitizedResources(value: unknown): void {
    for (const id of collectResourceIds(value))
      this.resourceManager.releaseLocalResource(id);
  }

  /** A late response must not release a capability already held by the caller. */
  public releaseOrphanedResponseResources(
    value: unknown,
    source: string,
    dispatchRelease: (id: string, source: string) => void,
    scope?: ResourceScope,
  ): void {
    for (const id of collectResourceIds(value)) {
      if (!this.resourceManager.hasRemoteProxy(id, source, scope))
        dispatchRelease(id, source);
    }
  }

  // ===== Conversion transactions: mutable tracking belongs to the payload, not the processor =====

  /** Run one transactional encoding pass and roll back IDs on conversion failure. */
  private async safeSanitizeWithContext(
    args: any[],
    context: Omit<SanitizeContext, "createdResourceIds">,
    reservation?: PayloadReservationOptions,
  ): Promise<Result<any[], Error>> {
    if (context.scope?.closed)
      return Result.err(scopeClosedError(context.scope));
    const createdResourceIds: string[] = [];
    const lease = createByteReservationLease(reservation);
    const budget = {
      nodes: 0,
      textBytes: 0,
      rawBytes: 0,
      lease,
      signal: reservation?.signal,
    };
    const attempted = await Result.tryPromise({
      try: async () => {
        if (budget.signal?.aborted)
          throw new DOMException("Payload preparation aborted.", "AbortError");
        const encoded = await this.sanitize(
          args,
          { ...context, createdResourceIds },
          new Set(),
          0,
          budget,
        );
        if (budget.signal?.aborted)
          throw new DOMException("Payload preparation aborted.", "AbortError");
        return Array.isArray(encoded) ? encoded : [encoded];
      },
      catch: toFrameworkProtocolError,
    });
    const result = attempted
      .andThen((encoded) =>
        context.scope?.closed
          ? Result.err(scopeClosedError(context.scope))
          : Result.ok(encoded),
      )
      .andThen((encoded) =>
        reservation
          ? Result.try({
              try: () => reservation.onLease(lease),
              catch: toFrameworkProtocolError,
            }).map(() => encoded)
          : Result.ok(encoded),
      );
    // Encoding is transactional until a message is accepted by the connection.
    if (result.isErr()) {
      for (const id of createdResourceIds)
        this.resourceManager.releaseLocalResource(id);
      lease.releaseAll();
    }
    return result;
  }

  /** Recursively encode values and allocate session-owned capability IDs. */
  private async sanitize(
    value: any,
    context: SanitizeContext,
    ancestors: ReadonlySet<object>,
    depth: number,
    budget: SanitizeBudget,
  ): Promise<any> {
    if (budget.signal?.aborted)
      throw new DOMException("Payload preparation aborted.", "AbortError");
    if (depth > MAX_PAYLOAD_DEPTH || ++budget.nodes > MAX_PAYLOAD_NODES)
      throw new TypeError("Payload traversal limit exceeded.");
    if (typeof value === "function" || isRefWrapper(value)) {
      const target = typeof value === "function" ? value : value.target;
      const binding = remoteBinding(target);
      if (
        binding &&
        (binding.scope !== context.scope ||
          binding.connectionId !== context.targetConnectionId)
      )
        throw new Error(
          "Remote capabilities cannot be implicitly exported into another resource scope.",
        );
      const id = this.resourceManager.registerLocalResource(
        target,
        context.targetConnectionId,
        context.serviceName || undefined,
        context.serviceName ? context.servicePolicy : undefined,
        ...(context.scope ? [context.scope] : []),
      );
      context.createdResourceIds.push(id);
      return Placeholder.encode(PlaceholderType.RESOURCE, id);
    }
    if (value === undefined)
      return Placeholder.encode(PlaceholderType.UNDEFINED);
    if (typeof value === "string") {
      if (value.length > DEFAULT_TRANSPORT_LIMITS.maxMessageBytes)
        throw new TypeError("Payload text limit exceeded.");
      budget.textBytes += new TextEncoder().encode(value).byteLength;
      if (budget.textBytes > DEFAULT_TRANSPORT_LIMITS.maxMessageBytes)
        throw new TypeError("Payload text limit exceeded.");
      return value.startsWith(PLACEHOLDER_PREFIX) ||
        value.startsWith(ESCAPE_CHAR)
        ? ESCAPE_CHAR + value
        : value;
    }
    if (typeof value === "bigint")
      return Placeholder.encode(PlaceholderType.BIGINT, value.toString());
    const binary = snapshotBinary(value, budget);
    if (binary) return binary;
    if (value instanceof Map) {
      if (ancestors.has(value))
        throw new TypeError("Cyclic payload values are not supported.");
      const next = new Set(ancestors).add(value);
      const entries: [unknown, unknown][] = [];
      for (const [key, item] of value)
        entries.push([
          await this.sanitize(key, context, next, depth + 1, budget),
          await this.sanitize(item, context, next, depth + 1, budget),
        ]);
      return new Map(entries);
    }
    if (value instanceof Set || Array.isArray(value)) {
      if (ancestors.has(value))
        throw new TypeError("Cyclic payload values are not supported.");
      const next = new Set(ancestors).add(value);
      const values: unknown[] = [];
      for (const item of value)
        values.push(
          await this.sanitize(item, context, next, depth + 1, budget),
        );
      return value instanceof Set ? new Set(values) : values;
    }
    if (value !== null && typeof value === "object") {
      if (ancestors.has(value))
        throw new TypeError("Cyclic payload values are not supported.");
      if (value instanceof Blob) {
        reserveRawBytes(value.size, budget);
        const pendingBytes = await value.arrayBuffer();
        if (budget.signal?.aborted)
          throw new DOMException("Payload preparation aborted.", "AbortError");
        const bytes = new Uint8Array(pendingBytes);
        if (bytes.byteLength !== value.size)
          throw new TypeError("Blob size changed while preparing payload.");
        return createBinaryValue("blob", bytes, value.type);
      }
      const next = new Set(ancestors).add(value);
      const result: Record<string, any> = Object.create(null);
      for (const key of Object.keys(value))
        result[key] = await this.sanitize(
          value[key],
          context,
          next,
          depth + 1,
          budget,
        );
      return result;
    }
    return value;
  }

  /** Recursively decode placeholders, sharing identities within one payload. */
  private revive(value: any, context: RevivalContext): any {
    if (isBinaryValue(value)) return decodeBinaryValue(value);
    if (typeof value === "string" && value.startsWith(ESCAPE_CHAR))
      return value.substring(ESCAPE_CHAR.length);
    const placeholder = Placeholder.fromString(value);
    if (placeholder) {
      if (placeholder.type !== PlaceholderType.RESOURCE) {
        const handler = REVIVER_TABLE_CONFIG.get(placeholder.type);
        if (handler) return this.revive(handler(placeholder.payload!), context);
        this.logger.warn(
          `No reviver handler for placeholder type "${placeholder.type}". Returning as is.`,
          placeholder,
        );
        return value;
      }
      const identity = validateResourceId(placeholder.payload ?? "");
      // One payload can repeat an identity; keep one facade and one rollback entry.
      const previous = context.revived.get(identity);
      if (previous) return previous.proxy;
      const existedBeforeRevive = this.resourceManager.hasRemoteProxy(
        identity,
        context.sourceConnectionId,
        context.scope,
      );
      const proxy = this.proxyFactory.createRemoteResourceProxy(
        identity,
        context.sourceConnectionId,
        context.callTimeout,
        context.scope,
      );
      context.revived.set(identity, { proxy, existedBeforeRevive });
      return proxy;
    }
    if (Array.isArray(value))
      return value.map((item: any) => this.revive(item, context));
    if (value instanceof Map)
      return new Map(
        [...value].map(([key, item]) => [
          this.revive(key, context),
          this.revive(item, context),
        ]),
      );
    if (value instanceof Set)
      return new Set([...value].map((item) => this.revive(item, context)));
    if (value !== null && typeof value === "object") {
      // Preserve null-prototype revival: a wire __proto__ key must stay ordinary data.
      const result: Record<string, any> = Object.create(null);
      for (const key of Object.keys(value))
        result[key] = this.revive(value[key], context);
      return result;
    }
    return value;
  }
}

/** Collect resource placeholders so an unaccepted payload can release its IDs. */
function collectResourceIds(
  value: unknown,
  ids = new Set<string>(),
): Set<string> {
  if (isBinaryValue(value)) return ids;
  if (value && typeof value === "object") {
    const children =
      value instanceof Map
        ? value.entries()
        : value instanceof Set || Array.isArray(value)
          ? value
          : Object.values(value);
    for (const item of children) collectResourceIds(item, ids);
  } else {
    const placeholder = Placeholder.fromString(value);
    if (placeholder?.type === PlaceholderType.RESOURCE && placeholder.payload)
      ids.add(placeholder.payload);
  }
  return ids;
}

function snapshotBinary(value: unknown, budget: SanitizeBudget) {
  if (value instanceof ArrayBuffer) return snapshotArrayBuffer(value, budget);
  if (ArrayBuffer.isView(value)) {
    const tag = Object.prototype.toString.call(value);
    if (tag !== "[object Uint8Array]")
      throw new TypeError(
        "Only Uint8Array and Node Buffer binary views are supported.",
      );
    const view = value as Uint8Array;
    if (
      Object.prototype.toString.call(view.buffer) ===
      "[object SharedArrayBuffer]"
    )
      throw new TypeError("SharedArrayBuffer values are not supported.");
    reserveRawBytes(view.byteLength, budget);
    return createBinaryValue(
      "uint8-array",
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice(),
    );
  }
  if (value !== null && typeof value === "object") {
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object ArrayBuffer]")
      return snapshotArrayBuffer(value as ArrayBuffer, budget);
  }
  return undefined;
}

function snapshotArrayBuffer(buffer: ArrayBuffer, budget: SanitizeBudget) {
  reserveRawBytes(buffer.byteLength, budget);
  try {
    return createBinaryValue("array-buffer", new Uint8Array(buffer.slice(0)));
  } catch {
    throw new TypeError("Detached ArrayBuffer values are not supported.");
  }
}

function reserveRawBytes(byteLength: number, budget: SanitizeBudget): void {
  if (byteLength > DEFAULT_TRANSPORT_LIMITS.maxMessageBytes - budget.rawBytes)
    throw new TypeError("Payload binary byte limit exceeded.");
  if (!budget.lease.reserve(byteLength))
    throw new TypeError("Shared transport buffer capacity exceeded.");
  budget.rawBytes += byteLength;
}

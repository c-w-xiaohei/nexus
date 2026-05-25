import { NexusUsageError } from "@/errors";
import type { EndpointMeta } from "@/types/identity";
import type { InlineTarget } from "./types/config";

export interface TokenOptions<U extends EndpointMeta = EndpointMeta> {
  defaultTarget?: InlineTarget<U> | null;
}

export class Token<T, U extends EndpointMeta = EndpointMeta> {
  declare readonly __shape?: T;
  declare readonly __metadata?: U;

  public readonly id: string;
  public readonly defaultTarget?: InlineTarget<U>;

  constructor(id: string, options?: TokenOptions<U>) {
    this.id = id;
    validateDefaultTarget(options?.defaultTarget);
    this.defaultTarget = options?.defaultTarget ?? undefined;
  }
}

export function validateDefaultTarget(target: unknown): void {
  if (target === null || typeof target === "undefined") {
    return;
  }
  if (typeof target !== "object" || Array.isArray(target)) {
    throw new NexusUsageError(
      "Token defaultTarget must be a plain object when provided.",
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }

  const input = target as Record<string, unknown>;
  const invalidKeys = Object.keys(input).filter(
    (key) => key !== "descriptor" && key !== "matcher",
  );
  if (invalidKeys.length > 0) {
    throw new NexusUsageError(
      `Token defaultTarget only supports descriptor and matcher; invalid key(s): ${invalidKeys.join(", ")}. Pass expects and timeout at the create() call-site.`,
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }
  if (!Object.hasOwn(input, "descriptor") && !Object.hasOwn(input, "matcher")) {
    throw new NexusUsageError(
      "Token defaultTarget requires at least one of descriptor or matcher.",
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }
  const hasDescriptor = Object.hasOwn(input, "descriptor");
  const hasMatcher = Object.hasOwn(input, "matcher");
  const descriptor = input.descriptor;
  const matcher = input.matcher;
  const descriptorIsInvalid =
    hasDescriptor &&
    (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor));
  const matcherIsInvalid = hasMatcher && typeof matcher !== "function";

  if (descriptorIsInvalid || matcherIsInvalid) {
    throw new NexusUsageError(
      "Token defaultTarget only supports inline descriptor objects and matcher functions.",
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }
}

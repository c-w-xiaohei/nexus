import { NexusUsageError } from "@/errors";
import type { AdapterModel, ConnectionTargetOf } from "@/types/adapter-model";

export interface TokenOptions<M extends AdapterModel> {
  defaultTarget?: ConnectionTargetOf<M>;
}

export class Token<T, M extends AdapterModel | never = never> {
  declare readonly __shape?: T;
  // An unbound token is a portable service contract. Once it has a default
  // target, its model becomes invariant so that target cannot cross adapters.
  declare readonly __modelInvariant?: [M] extends [never]
    ? never
    : (model: M) => M;

  public readonly id: string;
  public readonly defaultTarget?: M extends AdapterModel
    ? ConnectionTargetOf<M>
    : never;

  constructor(id: string, options?: TokenOptions<M & AdapterModel>) {
    this.id = id;
    validateDefaultTarget(options?.defaultTarget);
    this.defaultTarget = (options?.defaultTarget ??
      undefined) as M extends AdapterModel ? ConnectionTargetOf<M> : never;
  }
}

export function validateDefaultTarget(target: unknown): void {
  if (typeof target === "undefined") return;
  if (!isPlainTarget(target)) {
    throw new NexusUsageError(
      "Token defaultTarget must be a plain object when provided.",
      "E_USAGE_DEFAULT_CREATE_CONFLICT",
    );
  }
}

export const isPlainTarget = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

import type { AdapterModel } from "@/types/adapter-model";

export class Token<T, M extends AdapterModel | never = never> {
  declare readonly __shape?: T;
  // Unbound tokens are portable; explicitly model-bound contracts remain invariant.
  declare readonly __modelInvariant?: [M] extends [never]
    ? never
    : (model: M) => M;

  public readonly id: string;
  /** Identifies a shared service contract without choosing a connection or address. */
  constructor(id: string) {
    this.id = id;
  }
}

/** Recognizes plain exact-target records without cloning away an invalid prototype. */
export const isPlainTarget = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

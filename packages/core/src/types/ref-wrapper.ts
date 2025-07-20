/**
 * A unique symbol to identify a RefWrapper object without using `instanceof`.
 * This avoids circular dependencies and is more robust across different realms.
 */
export const REF_WRAPPER_SYMBOL = Symbol.for("nexus.ref.wrapper");

/**
 * An interface for an object that has been explicitly marked to be passed by reference.
 */
export interface RefWrapper<T extends object = object> {
  /** The special symbol that marks this as a ref-wrapped object. */
  readonly [REF_WRAPPER_SYMBOL]: true;
  /** The original object that should be passed by reference. */
  readonly target: T;
}

/**
 * Type guard to check if a value is a RefWrapper.
 * @param value The value to check.
 * @returns True if the value is a RefWrapper, false otherwise.
 */
export function isRefWrapper(value: unknown): value is RefWrapper {
  // Check for the presence of the symbol and that the target is an object.
  // This is a more robust check than just looking at the symbol.
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RefWrapper)[REF_WRAPPER_SYMBOL] === true &&
    typeof (value as RefWrapper).target === "object" &&
    (value as RefWrapper).target !== null
  );
}

import { Result } from "better-result";

type Listener<T> = (value: T) => void;

/** Subscription-only handle; each registration returns its own idempotent cancellation. */
export type EvtChannel<T> = (listener: Listener<T>) => () => void;

/** Producer-only handle. Keep it with the owner of the event. */
export interface EvtChannelController<T> {
  /** Attempts all active listeners and returns their failures in delivery order, without rollback. */
  readonly safeEmit: (value: T) => Result<void, readonly unknown[]>;
  /** Removes existing subscriptions, including pending deliveries; future subscriptions remain valid. */
  readonly clear: () => void;
}

/**
 * Captures listeners per emission: cancellation is immediate, additions start on
 * the next emission, and nested emissions are synchronous. The owner handles
 * returned failures; asynchronous callback results are not observed or awaited.
 */
export function createEvtChannel<T>(): readonly [
  subscribe: EvtChannel<T>,
  controller: EvtChannelController<T>,
] {
  const listeners = new Set<Listener<T>>();

  return [
    (listener) => {
      // Each registration has its own identity, even for the same callback.
      const subscription: Listener<T> = (value) => listener(value);
      listeners.add(subscription);
      return () => {
        listeners.delete(subscription);
      };
    },
    {
      safeEmit(value) {
        let failures: unknown[] | undefined;
        for (const listener of Array.from(listeners)) {
          if (!listeners.has(listener)) continue;
          try {
            listener(value);
          } catch (error) {
            (failures ??= []).push(error);
          }
        }
        return failures ? Result.err(failures) : Result.ok(undefined);
      },
      clear() {
        listeners.clear();
      },
    },
  ];
}

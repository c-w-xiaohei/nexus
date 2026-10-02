/** Runtime-owned byte budget callbacks used while a prepared value is retained. */
export interface ByteReservationBudget {
  reserveBytes(bytes: number): boolean;
  releaseBytes(bytes: number): void;
}

/** Idempotent ownership handle for bytes retained across prepare/encode/send. */
export interface ByteReservationLease {
  reserve(bytes: number): boolean;
  release(bytes: number): void;
  /** Releases every byte still held by this lease. Safe to call repeatedly. */
  releaseAll(): void;
}

export function createByteReservationLease(
  budget?: ByteReservationBudget,
): ByteReservationLease {
  let held = 0;
  let released = false;
  const lease: ByteReservationLease = {
    reserve(bytes) {
      if (released || !Number.isSafeInteger(bytes) || bytes < 0) return false;
      if (bytes === 0) return true;
      if (budget && !budget.reserveBytes(bytes)) return false;
      held += bytes;
      return true;
    },
    release(bytes) {
      if (released || !Number.isSafeInteger(bytes) || bytes <= 0) return;
      const amount = Math.min(bytes, held);
      held -= amount;
      budget?.releaseBytes(amount);
    },
    releaseAll() {
      if (released) return;
      released = true;
      if (held > 0) budget?.releaseBytes(held);
      held = 0;
    },
  };
  return lease;
}

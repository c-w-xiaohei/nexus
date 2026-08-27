export class BarrierTimeoutError extends Error {
  public constructor(
    readonly barrier: string,
    readonly lastEvents: readonly string[],
  ) {
    super(`Timed out waiting for barrier: ${barrier}`);
    this.name = "BarrierTimeoutError";
  }
}

export const waitForBarrier = async ({
  name,
  timeoutMs,
  pollIntervalMs = 25,
  readEvents,
}: {
  readonly name: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly readEvents: () => Promise<readonly string[]>;
}): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastEvents = await readEvents();
  while (!lastEvents.includes(name) && Date.now() < deadline) {
    await delay(pollIntervalMs);
    lastEvents = await readEvents();
  }
  if (lastEvents.includes(name)) return;
  throw new BarrierTimeoutError(name, lastEvents);
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

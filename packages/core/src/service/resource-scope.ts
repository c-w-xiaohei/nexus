import { Result } from "better-result";
import { NexusResourceError } from "../errors/resource-errors";
import { createEvtChannel } from "../utils/evt-channel";
import { Logger } from "../logger";

/** A session-bound region of remote calls and capabilities. Closing never invokes business methods. */
export interface ResourceScope extends Disposable {
  readonly id: string;
  readonly serviceId: string;
  readonly closed: boolean;
  /** Ends this region permanently, leaving the shared Connection open. */
  close(): void;
  /** Delivers termination once, including to late subscribers. */
  onClosed(listener: () => void): () => void;
}

const logger = new Logger("L3 --- ResourceScope");

/** Core-owned identity; the root requester/provider direction is immutable. */
export class ResourceScopeHandle implements ResourceScope {
  private ended = false;
  private readonly events = createEvtChannel<void>();

  constructor(
    readonly id: string,
    readonly serviceId: string,
    readonly connectionId: string,
    readonly direction: "requester" | "provider",
    private readonly terminate: (
      scope: ResourceScopeHandle,
      notifyPeer: boolean,
    ) => void,
  ) {}

  get closed(): boolean {
    return this.ended;
  }

  close(): void {
    this.finish(true);
  }

  /** Discards local ownership before admission or after the physical session ends. */
  discard(): void {
    this.finish(false);
  }

  private finish(notifyPeer: boolean): void {
    if (this.ended) return;
    this.ended = true;
    // Internal cleanup precedes user listeners, including reentrant observers.
    Result.try({
      try: () => this.terminate(this, notifyPeer),
      catch: (error) => error,
    }).tapError((error) => logger.error("Scope cleanup failed", error));
    this.events[1]
      .safeEmit(undefined)
      .tapError((errors) => logger.error("Scope observers failed", errors));
    this.events[1].clear();
  }

  onClosed(listener: () => void): () => void {
    if (!this.ended) return this.events[0](listener);
    Result.try({ try: listener, catch: (error) => error }).tapError((error) =>
      logger.error("Scope observer failed", error),
    );
    return () => {};
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

export function scopeClosedError(scope: ResourceScope): NexusResourceError {
  return new NexusResourceError(
    "The resource scope is closed.",
    "E_RESOURCE_SCOPE_CLOSED",
    { scopeId: scope.id, serviceName: scope.serviceId },
  );
}

import { Result } from "better-result";
import {
  NexusCallTimeoutError,
  NexusError,
  NexusProtocolError,
  serializeFrameworkError,
  toFrameworkProtocolError,
} from "../errors";
import {
  isRpcRequest,
  NexusMessageType,
  type RpcMessage,
} from "../types/message";
import { ResourceScopeHandle, scopeClosedError } from "./resource-scope";

export interface RelayPeer {
  createScope(serviceId: string): Result<ResourceScopeHandle, Error>;
  send(message: RpcMessage, scope: ResourceScopeHandle): Result<void, Error>;
  bind(
    scope: ResourceScopeHandle,
    receive: (message: RpcMessage, receivedAt: number) => Result<void, Error>,
  ): void;
}

/** Registration lifetime is independent of the sessions acquired on demand. */
export interface RelayRegistration {
  readonly services: readonly string[];
  readonly signal: AbortSignal;
  acquire(
    timeout: number,
    signal: AbortSignal,
  ): Promise<Result<RelayPeer, Error>>;
}

/** Both directions use the same budget arithmetic, including time spent acquiring or authorizing. */
export function relayBudget(
  message: RpcMessage,
  elapsed = 0,
): Result<number, NexusError> {
  const timeout = isRpcRequest(message) ? message.timeoutMs : 5_000;
  if (!timeout || (isRpcRequest(message) && (message.hops ?? 16) <= 0))
    return Result.err(
      new NexusProtocolError(
        "Relay requests require a time budget and remaining hop allowance.",
      ),
    );
  const remaining = timeout - elapsed;
  return remaining > 0
    ? Result.ok(remaining)
    : Result.err(new NexusCallTimeoutError("Relay call budget exhausted."));
}

function forwardMessage(
  message: RpcMessage,
  scopeId: string,
  receivedAt: number,
): Result<RpcMessage, NexusError> {
  if (!isRpcRequest(message)) return Result.ok({ ...message, scopeId });
  return relayBudget(message, performance.now() - receivedAt).map(
    (timeoutMs) => ({
      ...message,
      scopeId,
      timeoutMs,
      hops: (message.hops ?? 16) - 1,
    }),
  );
}

type Upstream = { peer: RelayPeer; scope: ResourceScopeHandle };

/** One local inbound domain owns acquisition, forwarding, and failed-establishment cleanup. */
export class RelayForwarder {
  private upstream:
    | { status: "idle" }
    | { status: "opening"; result: Promise<Result<Upstream, Error>> }
    | { status: "ready"; value: Upstream } = { status: "idle" };
  private waiting = 0;
  private readonly abort = new AbortController();

  constructor(
    private readonly scope: ResourceScopeHandle,
    private readonly registration: RelayRegistration,
    private readonly sendBack: (message: RpcMessage) => Result<void, Error>,
    private readonly reserveWaiter: () => Result<() => void, Error>,
  ) {
    const close = () => scope.close();
    registration.signal.addEventListener("abort", close, { once: true });
    scope.onClosed(() => {
      this.abort.abort();
      registration.signal.removeEventListener("abort", close);
    });
    if (registration.signal.aborted) close();
  }

  async forward(
    message: RpcMessage,
    receivedAt: number,
  ): Promise<Result<void, Error>> {
    let result = await this.send(message, receivedAt);
    if (result.isErr()) {
      // Reply before closing: a failed first call retains its precise error.
      if (isRpcRequest(message)) {
        const replied = this.sendBack({
          type: NexusMessageType.ERR,
          id: message.id,
          scopeId: this.scope.id,
          error: serializeFrameworkError(
            result.error instanceof NexusError
              ? result.error
              : toFrameworkProtocolError(result.error),
          ),
        });
        if (replied.isErr()) result = replied;
      }
      if (this.upstream.status !== "ready" && this.waiting === 0)
        this.scope.close();
    }
    return result;
  }

  private async send(
    message: RpcMessage,
    receivedAt: number,
  ): Promise<Result<void, Error>> {
    if (this.scope.closed) return Result.err(scopeClosedError(this.scope));
    const budget = relayBudget(message, performance.now() - receivedAt);
    if (budget.isErr()) return budget;
    const opened =
      this.upstream.status === "ready"
        ? Result.ok(this.upstream.value)
        : await this.acquire(budget.value);
    if (opened.isErr()) return opened;
    if (this.scope.closed) return Result.err(scopeClosedError(this.scope));
    const { peer, scope } = opened.value;
    return forwardMessage(message, scope.id, receivedAt).andThen((forwarded) =>
      peer.send(forwarded, scope),
    );
  }

  private async acquire(timeout: number): Promise<Result<Upstream, Error>> {
    const reserved = this.reserveWaiter();
    if (reserved.isErr()) return reserved;
    if (this.upstream.status === "idle")
      this.upstream = { status: "opening", result: this.open(timeout) };
    this.waiting++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = () => {};
    try {
      const interrupted = new Promise<Result<never, Error>>((resolve) => {
        timer = setTimeout(
          () =>
            resolve(
              Result.err(
                new NexusCallTimeoutError("Relay call budget exhausted."),
              ),
            ),
          timeout,
        );
        stop = this.scope.onClosed(() =>
          resolve(Result.err(scopeClosedError(this.scope))),
        );
      });
      const opening =
        this.upstream.status === "ready"
          ? Result.ok(this.upstream.value)
          : this.upstream.result;
      return await Promise.race([opening, interrupted]);
    } finally {
      clearTimeout(timer);
      stop();
      this.waiting--;
      reserved.value();
    }
  }

  private async open(timeout: number): Promise<Result<Upstream, Error>> {
    const acquired = await this.registration.acquire(
      timeout,
      this.abort.signal,
    );
    if (acquired.isErr()) return acquired;
    if (this.scope.closed) return Result.err(scopeClosedError(this.scope));
    const peer = acquired.value;
    const created = peer.createScope(this.scope.serviceId);
    if (created.isErr()) return created;
    const scope = created.value;
    const stopLocal = this.scope.onClosed(() => scope.close());
    scope.onClosed(() => {
      stopLocal();
      this.scope.close();
    });
    peer.bind(scope, (message, receivedAt) => {
      if (this.scope.closed) return Result.err(scopeClosedError(this.scope));
      const forwarded = forwardMessage(message, this.scope.id, receivedAt);
      if (forwarded.isErr() && isRpcRequest(message))
        return peer.send(
          {
            type: NexusMessageType.ERR,
            id: message.id,
            scopeId: scope.id,
            error: serializeFrameworkError(forwarded.error),
          },
          scope,
        );
      return forwarded.andThen(this.sendBack);
    });
    const upstream = { peer, scope };
    this.upstream = { status: "ready", value: upstream };
    return Result.ok(upstream);
  }
}

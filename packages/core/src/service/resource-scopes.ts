import { Result } from "better-result";
import { NexusProtocolError } from "../errors";
import { ResourceScopeHandle, type ResourceScope } from "./resource-scope";

/** Bound retained identities prevent late packets from reopening closed domains. */
export const MAX_SESSION_SCOPES = 4096;
export const MAX_SESSION_ESTABLISHMENT = 256;

/** Owns scope identity and default-service reuse, independently of RPC resources. */
export class ResourceScopes {
  private readonly waiters = new Map<string, number>();
  private readonly provisional = new Map<
    string,
    Map<string, ResourceScopeHandle>
  >();
  private readonly sessions = new Map<
    string,
    Map<string, ResourceScopeHandle>
  >();
  private readonly defaults = new Map<
    string,
    Map<string, ResourceScopeHandle>
  >();

  constructor(
    private readonly onClose: (
      scope: ResourceScopeHandle,
      notifyPeer: boolean,
    ) => void,
  ) {}

  /** Admission and unresolved mapping acquisition share one session budget. */
  reserveWaiter(connectionId: string): Result<() => void, Error> {
    const count = this.waiters.get(connectionId) ?? 0;
    if (count >= MAX_SESSION_ESTABLISHMENT)
      return Result.err(
        new NexusProtocolError("Relay acquisition queue capacity exceeded."),
      );
    this.waiters.set(connectionId, count + 1);
    return Result.ok(() => {
      const remaining = (this.waiters.get(connectionId) ?? 1) - 1;
      if (remaining > 0) this.waiters.set(connectionId, remaining);
      else this.waiters.delete(connectionId);
    });
  }

  get(connectionId: string, id: string): ResourceScopeHandle | undefined {
    return (
      this.sessions.get(connectionId)?.get(id) ??
      this.provisional.get(connectionId)?.get(id)
    );
  }

  /** Untrusted first roots reserve bounded space without consuming admitted identities. */
  reserve(
    connectionId: string,
    serviceId: string,
    id: string,
  ): Result<ResourceScopeHandle, Error> {
    let pending = this.provisional.get(connectionId);
    if (!pending) this.provisional.set(connectionId, (pending = new Map()));
    if (pending.size >= MAX_SESSION_ESTABLISHMENT)
      return Result.err(
        new NexusProtocolError("Session scope admission capacity exceeded."),
      );
    const scope = new ResourceScopeHandle(
      id,
      serviceId,
      connectionId,
      "provider",
      this.onClose,
    );
    pending.set(id, scope);
    scope.onClosed(() => {
      pending.delete(id);
      if (!pending.size && this.provisional.get(connectionId) === pending)
        this.provisional.delete(connectionId);
    });
    return Result.ok(scope);
  }

  admit(scope: ResourceScopeHandle): Result<void, Error> {
    if (this.sessions.get(scope.connectionId)?.get(scope.id) === scope)
      return Result.ok(undefined);
    if (
      scope.closed ||
      this.provisional.get(scope.connectionId)?.get(scope.id) !== scope
    )
      return Result.err(new NexusProtocolError("Scope admission ended."));
    let session = this.sessions.get(scope.connectionId);
    if (!session) this.sessions.set(scope.connectionId, (session = new Map()));
    if (session.size >= MAX_SESSION_SCOPES)
      return Result.err(
        new NexusProtocolError("Session resource scope capacity exceeded."),
      );
    session.set(scope.id, scope);
    this.provisional.get(scope.connectionId)?.delete(scope.id);
    return Result.ok(undefined);
  }

  isAdmitted(scope: ResourceScopeHandle): boolean {
    return this.sessions.get(scope.connectionId)?.get(scope.id) === scope;
  }

  rejectAdmission(scope: ResourceScopeHandle): void {
    if (this.provisional.get(scope.connectionId)?.get(scope.id) === scope) {
      // Rejection must leave the caller's default/explicit scope reusable.
      scope.discard();
    }
  }

  owns(connectionId: string, serviceId: string, scope: ResourceScope): boolean {
    return (
      this.get(connectionId, scope.id) === scope &&
      scope.serviceId === serviceId
    );
  }

  safeCreate(
    connectionId: string,
    serviceId: string,
  ): Result<ResourceScopeHandle, Error> {
    let session = this.sessions.get(connectionId);
    if (!session) this.sessions.set(connectionId, (session = new Map()));
    if (session.size >= MAX_SESSION_SCOPES)
      return Result.err(
        new NexusProtocolError("Session resource scope capacity exceeded."),
      );
    const scope = new ResourceScopeHandle(
      crypto.randomUUID(),
      serviceId,
      connectionId,
      "requester",
      this.onClose,
    );
    session.set(scope.id, scope);
    return Result.ok(scope);
  }

  safeDefault(
    connectionId: string,
    serviceId: string,
  ): Result<ResourceScopeHandle, Error> {
    let services = this.defaults.get(connectionId);
    if (!services) this.defaults.set(connectionId, (services = new Map()));
    const current = services.get(serviceId);
    if (current && !current.closed) return Result.ok(current);
    return this.safeCreate(connectionId, serviceId).tap((scope) =>
      services.set(serviceId, scope),
    );
  }

  closeConnection(connectionId: string): void {
    // Detach first so callbacks cannot reacquire a domain from this dead session.
    const scopes = this.sessions.get(connectionId);
    const pending = this.provisional.get(connectionId);
    this.provisional.delete(connectionId);
    this.sessions.delete(connectionId);
    this.defaults.delete(connectionId);
    for (const scope of scopes?.values() ?? []) scope.discard();
    for (const scope of pending?.values() ?? []) scope.discard();
  }
}

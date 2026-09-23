import type { AdapterModel } from "@/types/adapter-model";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import type { ResourceScope } from "./resource-scope";

interface ExposedServiceRecord {
  readonly service: object;
  readonly policy?: NexusAuthorizationPolicy<AdapterModel>;
}

interface LocalResourceRecord {
  target: object;
  ownerConnectionId: string;
  scope?: ResourceScope;
  /** Authorization snapshot captured when the capability was returned. */
  serviceName?: string;
  servicePolicy?: NexusAuthorizationPolicy<AdapterModel>;
}

/** Owns local capabilities and remote identities for one Engine. Registries never escape. */
export class ResourceManager {
  private readonly exposedServices = new Map<string, ExposedServiceRecord>();
  private readonly localResources = new Map<string, LocalResourceRecord>();
  private readonly remoteProxies = new Map<
    string,
    Map<ResourceScope | undefined, Set<string>>
  >();
  private resourceIdSeq = 1;

  /** Look up the callable service object without exposing its registration record. */
  public getExposedService(name: string): object | undefined {
    return this.exposedServices.get(name)?.service;
  }

  /** Look up a service and its captured authorization policy. */
  public getExposedServiceRecord(
    name: string,
  ): ExposedServiceRecord | undefined {
    return this.exposedServices.get(name);
  }

  /** Commits validated services without invoking application code or publishing between writes. */
  public registerExposedServices(
    providers: readonly (ExposedServiceRecord & { name: string })[],
  ): void {
    for (const { name, service, policy } of providers) {
      this.exposedServices.set(name, { service, policy });
    }
  }

  /** Return service objects for disconnect hooks without exposing registry state. */
  public listExposedServices(): readonly object[] {
    return Array.from(this.exposedServices.values(), ({ service }) => service);
  }

  /** Allocates a capability owned by one session, carrying its originating policy snapshot. */
  public registerLocalResource(
    target: object,
    ownerConnectionId: string,
    serviceName?: string,
    servicePolicy?: NexusAuthorizationPolicy<AdapterModel>,
    scope?: ResourceScope,
  ): string {
    const id = `res-${this.resourceIdSeq++}`;
    this.localResources.set(id, {
      target,
      ownerConnectionId,
      serviceName,
      servicePolicy,
      scope,
    });
    return id;
  }

  /** Look up a local capability for ownership and invocation checks. */
  public getLocalResource(id: string): LocalResourceRecord | undefined {
    return this.localResources.get(id);
  }

  /** Remove a locally owned capability after handoff, rejection, or release. */
  public releaseLocalResource(id: string): void {
    this.localResources.delete(id);
  }

  /** Track a remote identity under the session that can release it. */
  public registerRemoteProxy(
    id: string,
    source: string,
    scope?: ResourceScope,
  ): void {
    let scopes = this.remoteProxies.get(source);
    if (!scopes) this.remoteProxies.set(source, (scopes = new Map()));
    let ids = scopes.get(scope);
    if (!ids) scopes.set(scope, (ids = new Set()));
    ids.add(id);
  }

  /** Stop tracking one remote identity without affecting sibling identities. */
  public releaseRemoteProxy(
    id: string,
    source: string,
    scope?: ResourceScope,
  ): void {
    const scopes = this.remoteProxies.get(source);
    if (!scopes) return;
    const ids = scopes.get(scope);
    if (ids?.delete(id) && !ids.size) scopes.delete(scope);
    if (!scopes.size) this.remoteProxies.delete(source);
  }

  /** Check remote ownership using separate identity and session keys. */
  public hasRemoteProxy(
    id: string,
    source: string,
    scope?: ResourceScope,
  ): boolean {
    return this.remoteProxies.get(source)?.get(scope)?.has(id) ?? false;
  }

  /** Check whether a local capability is still registered. */
  public hasLocalResource(id: string): boolean {
    return this.localResources.has(id);
  }

  /** Count capabilities currently owned by this engine. */
  public countLocalResources(): number {
    return this.localResources.size;
  }

  /** Count tracked remote identities across all source sessions. */
  public countRemoteProxies(): number {
    let count = 0;
    for (const scopes of this.remoteProxies.values())
      for (const ids of scopes.values()) count += ids.size;
    return count;
  }

  /** List local capability IDs that must be invalidated with one session. */
  public listLocalResourceIdsByOwner(connectionId: string): string[] {
    const ids: string[] = [];
    for (const [id, resource] of this.localResources) {
      if (resource.ownerConnectionId === connectionId) ids.push(id);
    }
    return ids;
  }

  /** Disconnect cleanup is local: the dead session cannot receive release notifications. */
  public cleanupConnection(connectionId: string): void {
    for (const [id, resource] of this.localResources)
      if (resource.ownerConnectionId === connectionId)
        this.localResources.delete(id);
    this.remoteProxies.delete(connectionId);
  }

  /** Scope termination never touches sibling scopes on the shared session. */
  public cleanupScope(scope: ResourceScope): void {
    for (const [id, resource] of this.localResources)
      if (resource.scope === scope) this.localResources.delete(id);
    for (const [source, scopes] of this.remoteProxies) {
      scopes.delete(scope);
      if (!scopes.size) this.remoteProxies.delete(source);
    }
  }
}

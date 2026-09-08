import { type LocalResourceRecord, LocalResourceType } from "./types";
import type { AdapterModel } from "@/types/adapter-model";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import { NexusConfigurationError } from "@/errors";
import { Logger } from "@/logger";
import { Result } from "better-result";

interface ExposedServiceRecord {
  readonly service: object;
  readonly policy?: NexusAuthorizationPolicy<AdapterModel>;
}

/** Owns local capabilities and remote identities for one Engine. Registries never escape. */
export class ResourceManager {
  private readonly logger = new Logger("L3 --- ResourceManager");
  private readonly exposedServices = new Map<string, ExposedServiceRecord>();
  private readonly localResources = new Map<string, LocalResourceRecord>();
  private readonly remoteProxies = new Set<string>();
  private resourceIdSeq = 1;

  public registerExposedService(
    name: string,
    service: object,
    policy?: NexusAuthorizationPolicy<AdapterModel>,
  ): void {
    if (this.exposedServices.has(name)) {
      const message = `Service with name "${name}" is already registered. Overwriting.`;
      this.logger.warn(message);
      console.warn(`Nexus L3: ${message}`);
    }
    this.exposedServices.set(name, { service, policy });
  }

  public getExposedService(name: string): object | undefined {
    return this.exposedServices.get(name)?.service;
  }

  public getExposedServiceRecord(
    name: string,
  ): ExposedServiceRecord | undefined {
    return this.exposedServices.get(name);
  }

  /** Validates the entire bootstrap batch before replacing any registration. */
  public safeRegisterExposedServicesBatch(
    providers: readonly (ExposedServiceRecord & { name: string })[],
  ): Result<void, Error> {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const { name } of providers) {
      if (seen.has(name)) duplicates.add(name);
      seen.add(name);
    }
    if (duplicates.size)
      return Result.err(
        new NexusConfigurationError(
          `Nexus: Provider token id already registered: ${[...duplicates].join(", ")}.`,
          "E_PROVIDER_DUPLICATE_TOKEN",
          { duplicateTokenIds: [...duplicates] },
        ),
      );
    for (const { name, service, policy } of providers) {
      this.exposedServices.set(name, { service, policy });
    }
    return Result.ok(undefined);
  }

  public listExposedServices(): readonly object[] {
    return Array.from(this.exposedServices.values(), ({ service }) => service);
  }

  /** Allocates a capability owned by one session, carrying its originating policy snapshot. */
  public registerLocalResource(
    target: object,
    ownerConnectionId: string,
    type: LocalResourceType,
    serviceName?: string,
    servicePolicy?: NexusAuthorizationPolicy<AdapterModel>,
  ): string {
    const id = `res-${this.resourceIdSeq++}`;
    this.localResources.set(id, {
      target,
      ownerConnectionId,
      type,
      serviceName,
      servicePolicy,
    });
    return id;
  }

  public getLocalResource(id: string): LocalResourceRecord | undefined {
    return this.localResources.get(id);
  }

  public releaseLocalResource(id: string): void {
    this.localResources.delete(id);
  }

  public registerRemoteProxy(id: string, source: string): void {
    this.remoteProxies.add(remoteProxyKey(id, source));
  }

  public releaseRemoteProxy(id: string, source: string): void {
    this.remoteProxies.delete(remoteProxyKey(id, source));
  }

  public hasRemoteProxy(id: string, source: string): boolean {
    return this.remoteProxies.has(remoteProxyKey(id, source));
  }

  public hasLocalResource(id: string): boolean {
    return this.localResources.has(id);
  }

  public countLocalResources(): number {
    return this.localResources.size;
  }
  public countRemoteProxies(): number {
    return this.remoteProxies.size;
  }

  public listRemoteProxyIdsBySource(connectionId: string): string[] {
    const ids: string[] = [];
    for (const key of this.remoteProxies) {
      const separator = key.indexOf("\u0000");
      if (key.slice(0, separator) === connectionId)
        ids.push(key.slice(separator + 1));
    }
    return ids;
  }

  public listLocalResourceIdsByOwner(connectionId: string): string[] {
    return [...this.localResources]
      .filter(([, record]) => record.ownerConnectionId === connectionId)
      .map(([id]) => id);
  }

  /** Disconnect cleanup is local: the dead session cannot receive release notifications. */
  public cleanupConnection(connectionId: string): void {
    for (const id of this.listLocalResourceIdsByOwner(connectionId))
      this.releaseLocalResource(id);
    for (const id of this.listRemoteProxyIdsBySource(connectionId))
      this.releaseRemoteProxy(id, connectionId);
  }
}

const remoteProxyKey = (id: string, source: string): string =>
  `${source}\u0000${id}`;

import {
  LocalResourceRecord,
  LocalResourceType,
  RemoteProxyRecord,
} from "./types";
import { Logger } from "@/logger";

let nextResourceId = 1;

/**
 * Manages the lifecycle and state of all local and remote resources.
 * This class is the stateful core of the service layer, tracking exposed
 * services, local resources passed by reference, and proxies to remote resources.
 */
export class ResourceManager {
  private readonly logger = new Logger("L3 --- ResourceManager");
  // Stores local services exposed via @Expose. Key: service name.
  private readonly exposedServices = new Map<string, object>();

  // Stores local resources passed by reference. Key: resource ID.
  private readonly localResourceRegistry = new Map<
    string,
    LocalResourceRecord
  >();

  // Stores proxies to remote resources. Key: resource ID.
  private readonly remoteProxyRegistry = new Map<string, RemoteProxyRecord>();

  public registerExposedService(name: string, service: object): void {
    if (this.exposedServices.has(name)) {
      const message = `Service with name "${name}" is already registered. Overwriting.`;
      this.logger.warn(message);
      console.warn(`Nexus L3: ${message}`);
    }
    this.logger.debug(`Registered exposed service: "${name}"`, service);
    this.exposedServices.set(name, service);
  }

  public getExposedService(name: string): object | undefined {
    return this.exposedServices.get(name);
  }

  public registerLocalResource(
    target: object,
    ownerConnectionId: string,
    type: LocalResourceType
  ): string {
    const resourceId = `res-${nextResourceId++}`;
    this.logger.debug(
      `Registering local resource #${resourceId} for connection ${ownerConnectionId}.`,
      { type, target }
    );
    this.localResourceRegistry.set(resourceId, {
      target,
      ownerConnectionId,
      type,
    });
    return resourceId;
  }

  public getLocalResource(resourceId: string): LocalResourceRecord | undefined {
    return this.localResourceRegistry.get(resourceId);
  }

  public releaseLocalResource(resourceId: string): void {
    this.logger.debug(`Releasing local resource #${resourceId}`);
    this.localResourceRegistry.delete(resourceId);
  }

  public registerRemoteProxy(
    resourceId: string,
    proxy: object,
    sourceConnectionId: string
  ): void {
    this.logger.debug(
      `Registering remote proxy #${resourceId} from connection ${sourceConnectionId}.`
    );
    this.remoteProxyRegistry.set(resourceId, { proxy, sourceConnectionId });
  }

  public cleanupConnection(connectionId: string): void {
    this.logger.info(
      `Cleaning up all resources for connection ${connectionId}`
    );
    // Clean up local resources owned by the disconnected client
    for (const [resourceId, record] of this.localResourceRegistry.entries()) {
      if (record.ownerConnectionId === connectionId) {
        this.logger.debug(
          `Cleaning up local resource #${resourceId} due to disconnect.`
        );
        this.localResourceRegistry.delete(resourceId);
      }
    }

    // Clean up remote proxies that originated from the disconnected client
    for (const [resourceId, record] of this.remoteProxyRegistry.entries()) {
      if (record.sourceConnectionId === connectionId) {
        this.logger.debug(
          `Cleaning up remote proxy #${resourceId} due to disconnect.`
        );
        this.remoteProxyRegistry.delete(resourceId);
      }
    }
  }
}

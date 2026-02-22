import {
  LocalResourceRecord,
  LocalResourceType,
  RemoteProxyRecord,
} from "./types";
import { Logger } from "@/logger";

export namespace ResourceManager {
  export interface Runtime {
    registerExposedService(name: string, service: object): void;
    getExposedService(name: string): object | undefined;
    registerLocalResource(
      target: object,
      ownerConnectionId: string,
      type: LocalResourceType,
    ): string;
    getLocalResource(resourceId: string): LocalResourceRecord | undefined;
    releaseLocalResource(resourceId: string): void;
    registerRemoteProxy(
      resourceId: string,
      proxy: object,
      sourceConnectionId: string,
    ): void;
    hasLocalResource(resourceId: string): boolean;
    countLocalResources(): number;
    countRemoteProxies(): number;
    listRemoteProxyIdsBySource(connectionId: string): string[];
    listLocalResourceIdsByOwner(connectionId: string): string[];
    cleanupConnection(connectionId: string): void;
  }

  export const create = (): Runtime => {
    const logger = new Logger("L3 --- ResourceManager");
    const exposedServices = new Map<string, object>();
    const localResourceRegistry = new Map<string, LocalResourceRecord>();
    const remoteProxyRegistry = new Map<string, RemoteProxyRecord>();
    let resourceIdSeq = 1;

    const registerExposedService = (name: string, service: object): void => {
      if (exposedServices.has(name)) {
        const message = `Service with name "${name}" is already registered. Overwriting.`;
        logger.warn(message);
        console.warn(`Nexus L3: ${message}`);
      }
      logger.debug(`Registered exposed service: "${name}"`, service);
      exposedServices.set(name, service);
    };

    const getExposedService = (name: string): object | undefined =>
      exposedServices.get(name);

    const registerLocalResource = (
      target: object,
      ownerConnectionId: string,
      type: LocalResourceType,
    ): string => {
      const resourceId = `res-${resourceIdSeq++}`;
      logger.debug(
        `Registering local resource #${resourceId} for connection ${ownerConnectionId}.`,
        { type, target },
      );
      localResourceRegistry.set(resourceId, {
        target,
        ownerConnectionId,
        type,
      });
      return resourceId;
    };

    const getLocalResource = (
      resourceId: string,
    ): LocalResourceRecord | undefined => localResourceRegistry.get(resourceId);

    const releaseLocalResource = (resourceId: string): void => {
      logger.debug(`Releasing local resource #${resourceId}`);
      localResourceRegistry.delete(resourceId);
    };

    const registerRemoteProxy = (
      resourceId: string,
      proxy: object,
      sourceConnectionId: string,
    ): void => {
      logger.debug(
        `Registering remote proxy #${resourceId} from connection ${sourceConnectionId}.`,
      );
      remoteProxyRegistry.set(resourceId, { proxy, sourceConnectionId });
    };

    const hasLocalResource = (resourceId: string): boolean =>
      localResourceRegistry.has(resourceId);

    const countLocalResources = (): number => localResourceRegistry.size;

    const countRemoteProxies = (): number => remoteProxyRegistry.size;

    const listRemoteProxyIdsBySource = (connectionId: string): string[] => {
      const result: string[] = [];
      for (const [resourceId, record] of remoteProxyRegistry.entries()) {
        if (record.sourceConnectionId === connectionId) {
          result.push(resourceId);
        }
      }
      return result;
    };

    const listLocalResourceIdsByOwner = (connectionId: string): string[] => {
      const result: string[] = [];
      for (const [resourceId, record] of localResourceRegistry.entries()) {
        if (record.ownerConnectionId === connectionId) {
          result.push(resourceId);
        }
      }
      return result;
    };

    const cleanupConnection = (connectionId: string): void => {
      logger.info(`Cleaning up all resources for connection ${connectionId}`);

      const localResourceIdsToDelete: string[] = [];
      const remoteProxyIdsToDelete: string[] = [];

      for (const [resourceId, record] of localResourceRegistry.entries()) {
        if (record.ownerConnectionId === connectionId) {
          logger.debug(
            `Cleaning up local resource #${resourceId} due to disconnect.`,
          );
          localResourceIdsToDelete.push(resourceId);
        }
      }

      for (const resourceId of localResourceIdsToDelete) {
        localResourceRegistry.delete(resourceId);
      }

      for (const [resourceId, record] of remoteProxyRegistry.entries()) {
        if (record.sourceConnectionId === connectionId) {
          logger.debug(
            `Cleaning up remote proxy #${resourceId} due to disconnect.`,
          );
          remoteProxyIdsToDelete.push(resourceId);
        }
      }

      for (const resourceId of remoteProxyIdsToDelete) {
        remoteProxyRegistry.delete(resourceId);
      }
    };

    const runtime: Runtime = {
      registerExposedService,
      getExposedService,
      registerLocalResource,
      getLocalResource,
      releaseLocalResource,
      registerRemoteProxy,
      hasLocalResource,
      countLocalResources,
      countRemoteProxies,
      listRemoteProxyIdsBySource,
      listLocalResourceIdsByOwner,
      cleanupConnection,
    };

    return runtime;
  };
}

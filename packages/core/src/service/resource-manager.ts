import {
  LocalResourceRecord,
  LocalResourceType,
  RemoteProxyRecord,
} from "./types";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import { NexusConfigurationError } from "@/errors";
import { Logger } from "@/logger";
import { err, ok, type Result } from "neverthrow";

export namespace ResourceManager {
  export interface ExposedServiceRecord {
    readonly service: object;
    readonly policy?: NexusAuthorizationPolicy<any, any>;
  }

  export interface Runtime {
    registerExposedService(
      name: string,
      service: object,
      policy?: NexusAuthorizationPolicy<any, any>,
    ): void;
    getExposedService(name: string): object | undefined;
    getExposedServiceRecord(name: string): ExposedServiceRecord | undefined;
    safeRegisterExposedServicesBatch(
      services: readonly ExposedServiceBatchRegistration[],
    ): Result<void, Error>;
    listExposedServices(): readonly object[];
    registerLocalResource(
      target: object,
      ownerConnectionId: string,
      type: LocalResourceType,
      serviceName?: string,
      servicePolicy?: NexusAuthorizationPolicy<any, any>,
    ): string;
    getLocalResource(resourceId: string): LocalResourceRecord | undefined;
    getLocalResourceServiceName(resourceId: string): string | undefined;
    getLocalResourceServicePolicy(
      resourceId: string,
    ): NexusAuthorizationPolicy<any, any> | undefined;
    releaseLocalResource(resourceId: string): void;
    registerRemoteProxy(
      resourceId: string,
      proxy: object,
      sourceConnectionId: string,
    ): void;
    releaseRemoteProxy(resourceId: string): void;
    hasLocalResource(resourceId: string): boolean;
    countLocalResources(): number;
    countRemoteProxies(): number;
    listRemoteProxyIdsBySource(connectionId: string): string[];
    listLocalResourceIdsByOwner(connectionId: string): string[];
    cleanupConnection(connectionId: string): void;
  }

  export interface ExposedServiceBatchRegistration {
    readonly name: string;
    readonly service: object;
    readonly policy?: NexusAuthorizationPolicy<any, any>;
  }

  export const create = (): Runtime => {
    const logger = new Logger("L3 --- ResourceManager");
    const exposedServices = new Map<string, ExposedServiceRecord>();
    const localResourceRegistry = new Map<string, LocalResourceRecord>();
    const remoteProxyRegistry = new Map<string, RemoteProxyRecord>();
    let resourceIdSeq = 1;

    const registerExposedService = (
      name: string,
      service: object,
      policy?: NexusAuthorizationPolicy<any, any>,
    ): void => {
      if (exposedServices.has(name)) {
        const message = `Service with name "${name}" is already registered. Overwriting.`;
        logger.warn(message);
        console.warn(`Nexus L3: ${message}`);
      }
      logger.debug(`Registered exposed service: "${name}"`, service);
      exposedServices.set(name, { service, policy });
    };

    const getExposedService = (name: string): object | undefined =>
      exposedServices.get(name)?.service;

    const getExposedServiceRecord = (
      name: string,
    ): ExposedServiceRecord | undefined => exposedServices.get(name);

    const safeRegisterExposedServicesBatch = (
      services: readonly ExposedServiceBatchRegistration[],
    ): Result<void, Error> => {
      const seen = new Set<string>();
      const duplicateNames = new Set<string>();
      for (const registration of services) {
        if (
          seen.has(registration.name) ||
          exposedServices.has(registration.name)
        ) {
          duplicateNames.add(registration.name);
        }
        seen.add(registration.name);
      }

      if (duplicateNames.size > 0) {
        return err(
          new NexusConfigurationError(
            `Nexus: Provider token id already registered: ${Array.from(duplicateNames).join(", ")}.`,
            "E_PROVIDER_DUPLICATE_TOKEN",
            { duplicateTokenIds: Array.from(duplicateNames) },
          ),
        );
      }

      for (const registration of services) {
        logger.debug(
          `Registered exposed service: "${registration.name}"`,
          registration.service,
        );
        exposedServices.set(registration.name, {
          service: registration.service,
          policy: registration.policy,
        });
      }

      return ok(undefined);
    };

    const listExposedServices = (): readonly object[] =>
      Array.from(exposedServices.values(), ({ service }) => service);

    const registerLocalResource = (
      target: object,
      ownerConnectionId: string,
      type: LocalResourceType,
      serviceName?: string,
      servicePolicy?: NexusAuthorizationPolicy<any, any>,
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
        serviceName,
        servicePolicy,
      });
      return resourceId;
    };

    const getLocalResource = (
      resourceId: string,
    ): LocalResourceRecord | undefined => localResourceRegistry.get(resourceId);

    const getLocalResourceServiceName = (
      resourceId: string,
    ): string | undefined => localResourceRegistry.get(resourceId)?.serviceName;

    const getLocalResourceServicePolicy = (
      resourceId: string,
    ): NexusAuthorizationPolicy<any, any> | undefined =>
      localResourceRegistry.get(resourceId)?.servicePolicy as
        | NexusAuthorizationPolicy<any, any>
        | undefined;

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

    const releaseRemoteProxy = (resourceId: string): void => {
      logger.debug(`Releasing remote proxy #${resourceId}`);
      remoteProxyRegistry.delete(resourceId);
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
      getExposedServiceRecord,
      safeRegisterExposedServicesBatch,
      listExposedServices,
      registerLocalResource,
      getLocalResource,
      getLocalResourceServiceName,
      getLocalResourceServicePolicy,
      releaseLocalResource,
      registerRemoteProxy,
      releaseRemoteProxy,
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

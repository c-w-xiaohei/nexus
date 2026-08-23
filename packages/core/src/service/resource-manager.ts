import { LocalResourceRecord, LocalResourceType } from "./types";
import type { AdapterModel } from "@/types/adapter-model";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import { NexusConfigurationError } from "@/errors";
import { Logger } from "@/logger";
import { Result } from "better-result";
const { err, ok } = Result;

export namespace ResourceManager {
  export interface ExposedServiceRecord {
    readonly service: object;
    readonly policy?: NexusAuthorizationPolicy<AdapterModel>;
  }

  export interface Runtime {
    registerExposedService(
      name: string,
      service: object,
      policy?: NexusAuthorizationPolicy<AdapterModel>,
    ): void;
    getExposedService(name: string): object | undefined;
    getExposedServiceRecord(name: string): ExposedServiceRecord | undefined;
    safeRegisterExposedServicesBatch(
      providers: readonly ExposedServiceBatchRegistration[],
    ): Result<void, Error>;
    listExposedServices(): readonly object[];
    registerLocalResource(
      target: object,
      ownerConnectionId: string,
      type: LocalResourceType,
      serviceName?: string,
      servicePolicy?: NexusAuthorizationPolicy<AdapterModel>,
    ): string;
    getLocalResource(resourceId: string): LocalResourceRecord | undefined;
    getLocalResourceServiceName(resourceId: string): string | undefined;
    getLocalResourceServicePolicy(
      resourceId: string,
    ): NexusAuthorizationPolicy<AdapterModel> | undefined;
    releaseLocalResource(resourceId: string): void;
    registerRemoteProxy(resourceId: string, sourceConnectionId: string): void;
    releaseRemoteProxy(resourceId: string, sourceConnectionId: string): void;
    hasRemoteProxy(resourceId: string, sourceConnectionId: string): boolean;
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
    readonly policy?: NexusAuthorizationPolicy<AdapterModel>;
  }

  export const create = (): Runtime => {
    const logger = new Logger("L3 --- ResourceManager");
    const exposedServices = new Map<string, ExposedServiceRecord>();
    const localResourceRegistry = new Map<string, LocalResourceRecord>();
    const remoteProxyRegistry = new Set<string>();
    let resourceIdSeq = 1;

    const registerExposedService = (
      name: string,
      service: object,
      policy?: NexusAuthorizationPolicy<AdapterModel>,
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
      providers: readonly ExposedServiceBatchRegistration[],
    ): Result<void, Error> => {
      const seen = new Set<string>();
      const duplicateNames = new Set<string>();
      for (const registration of providers) {
        if (seen.has(registration.name)) {
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

      for (const registration of providers) {
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
      servicePolicy?: NexusAuthorizationPolicy<AdapterModel>,
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
    ): NexusAuthorizationPolicy<AdapterModel> | undefined =>
      localResourceRegistry.get(resourceId)?.servicePolicy as
        | NexusAuthorizationPolicy<AdapterModel>
        | undefined;

    const releaseLocalResource = (resourceId: string): void => {
      logger.debug(`Releasing local resource #${resourceId}`);
      localResourceRegistry.delete(resourceId);
    };

    const registerRemoteProxy = (
      resourceId: string,
      sourceConnectionId: string,
    ): void => {
      logger.debug(
        `Registering remote proxy #${resourceId} from connection ${sourceConnectionId}.`,
      );
      remoteProxyRegistry.add(
        createRemoteProxyKey(resourceId, sourceConnectionId),
      );
    };

    const releaseRemoteProxy = (
      resourceId: string,
      sourceConnectionId: string,
    ): void => {
      logger.debug(`Releasing remote proxy #${resourceId}`);
      remoteProxyRegistry.delete(
        createRemoteProxyKey(resourceId, sourceConnectionId),
      );
    };

    const hasRemoteProxy = (
      resourceId: string,
      sourceConnectionId: string,
    ): boolean =>
      remoteProxyRegistry.has(
        createRemoteProxyKey(resourceId, sourceConnectionId),
      );

    const hasLocalResource = (resourceId: string): boolean =>
      localResourceRegistry.has(resourceId);

    const countLocalResources = (): number => localResourceRegistry.size;

    const countRemoteProxies = (): number => remoteProxyRegistry.size;

    const listRemoteProxyIdsBySource = (connectionId: string): string[] => {
      const result: string[] = [];
      for (const key of remoteProxyRegistry) {
        const [sourceConnectionId, resourceId] = parseRemoteProxyKey(key);
        if (sourceConnectionId === connectionId) {
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
      const remoteProxyKeysToDelete: string[] = [];

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

      for (const key of remoteProxyRegistry) {
        const [sourceConnectionId, resourceId] = parseRemoteProxyKey(key);
        if (sourceConnectionId === connectionId) {
          logger.debug(
            `Cleaning up remote proxy #${resourceId} due to disconnect.`,
          );
          remoteProxyKeysToDelete.push(key);
        }
      }

      for (const key of remoteProxyKeysToDelete) {
        remoteProxyRegistry.delete(key);
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
      hasRemoteProxy,
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

const REMOTE_PROXY_KEY_SEPARATOR = "\u0000";

const createRemoteProxyKey = (
  resourceId: string,
  sourceConnectionId: string,
): string => `${sourceConnectionId}${REMOTE_PROXY_KEY_SEPARATOR}${resourceId}`;

const parseRemoteProxyKey = (key: string): [string, string] => {
  const separator = key.indexOf(REMOTE_PROXY_KEY_SEPARATOR);
  return [
    key.slice(0, separator),
    key.slice(separator + REMOTE_PROXY_KEY_SEPARATOR.length),
  ];
};

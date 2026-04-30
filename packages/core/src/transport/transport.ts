import type { IEndpoint } from "./types/endpoint";
import type { IPort } from "./types/port";
import { PortProcessor, type PortProcessorHandlers } from "./port-processor";
import { JsonSerializer } from "./serializers/json-serializer";
import { BinarySerializer } from "./serializers/binary-serializer";
import type { ISerializer } from "./serializers/interface";
import {
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
  NexusEndpointListenError,
} from "../errors/transport-errors";
import { errAsync, ResultAsync } from "neverthrow";

export namespace Transport {
  const shouldUseBinarySerializer = <U extends object, P extends object>(
    endpoint: IEndpoint<U, P>,
  ): boolean => {
    const capabilities = endpoint.capabilities;
    if (!capabilities) {
      return false;
    }

    if (typeof capabilities.binaryPackets === "boolean") {
      return capabilities.binaryPackets;
    }

    return capabilities.supportsTransferables === true;
  };

  export interface Context<U extends object, P extends object> {
    readonly endpoint: IEndpoint<U, P>;
    readonly serializer: ISerializer;
  }

  export const create = <U extends object, P extends object>(
    endpoint: IEndpoint<U, P>,
  ): Context<U, P> => ({
    endpoint,
    serializer: shouldUseBinarySerializer(endpoint)
      ? BinarySerializer.serializer
      : JsonSerializer.serializer,
  });

  export const safeListen = <U extends object, P extends object>(
    context: Context<U, P>,
    onConnect: (
      createProcessor: (
        handlers: PortProcessorHandlers,
      ) => PortProcessor.Context,
      platformMetadata?: P,
    ) => void,
  ): ResultAsync<void, NexusEndpointListenError> => {
    if (!context.endpoint.listen) {
      console.warn(
        "Nexus DEV: `listen` called on an endpoint that does not support it.",
      );
      return ResultAsync.fromSafePromise(Promise.resolve(undefined));
    }

    try {
      const listenResult = context.endpoint.listen(
        (port: IPort, platformMetadata?: P) => {
          const createProcessor = (
            handlers: PortProcessorHandlers,
          ): PortProcessor.Context =>
            PortProcessor.create(port, context.serializer, handlers);
          try {
            onConnect(createProcessor, platformMetadata);
          } catch (error) {
            console.error(
              "Nexus DEV: unhandled error in Transport.safeListen onConnect callback",
              error,
            );
          }
        },
      );
      return ResultAsync.fromPromise(Promise.resolve(listenResult), (error) =>
        createListenError(error),
      ).map(() => undefined);
    } catch (error) {
      return errAsync(createListenError(error));
    }
  };

  export const safeConnect = <U extends object, P extends object>(
    context: Context<U, P>,
    targetDescriptor: Partial<U>,
    handlers: PortProcessorHandlers,
  ): ResultAsync<
    [PortProcessor.Context, P],
    NexusEndpointCapabilityError | NexusEndpointConnectError
  > => {
    if (!context.endpoint.connect) {
      const capabilityError = new NexusEndpointCapabilityError(
        "Cannot connect: endpoint does not implement connect() method",
        {
          endpointType: "endpoint",
          targetDescriptor,
        },
      );

      return errAsync(capabilityError);
    }

    let connectPromise: Promise<[IPort, P]>;
    try {
      connectPromise = context.endpoint.connect(targetDescriptor);
    } catch (error) {
      return errAsync(
        new NexusEndpointConnectError(
          `Failed to connect endpoint: ${error instanceof Error ? error.message : String(error)}`,
          {
            endpointType: "endpoint",
            targetDescriptor,
            originalError: error,
          },
        ),
      );
    }

    return ResultAsync.fromPromise(
      connectPromise,
      (error) =>
        new NexusEndpointConnectError(
          `Failed to connect endpoint: ${error instanceof Error ? error.message : String(error)}`,
          {
            endpointType: "endpoint",
            targetDescriptor,
            originalError: error,
          },
        ),
    ).map(([port, platformMetadata]) => [
      PortProcessor.create(port, context.serializer, handlers),
      platformMetadata,
    ]);
  };
}

const createListenError = (error: unknown): NexusEndpointListenError =>
  new NexusEndpointListenError(
    `Failed to start endpoint listener: ${error instanceof Error ? error.message : String(error)}`,
    {
      endpointType: "endpoint",
      originalError: error,
    },
  );

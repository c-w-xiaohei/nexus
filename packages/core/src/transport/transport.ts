import type { IEndpoint } from "./types/endpoint.js";
import type { IPort } from "./types/port.js";
import { PortProcessor, type PortProcessorHandlers } from "./port-processor.js";
import { JsonSerializer } from "./serializers/json-serializer.js";
import { BinarySerializer } from "./serializers/binary-serializer.js";
import type { ISerializer } from "./serializers/interface.js";
import {
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
  NexusEndpointListenError,
} from "../errors/transport-errors.js";
import { Result } from "better-result";
const { err, ok } = Result;

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

  export const safeListen = async <U extends object, P extends object>(
    context: Context<U, P>,
    onConnect: (
      createProcessor: (
        handlers: PortProcessorHandlers,
      ) => PortProcessor.Context,
      platformMetadata?: P,
    ) => void,
  ): Promise<Result<void, NexusEndpointListenError>> => {
    if (!context.endpoint.listen) {
      console.warn(
        "Nexus DEV: `listen` called on an endpoint that does not support it.",
      );
      return ok(undefined);
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
      await listenResult;
      return ok(undefined);
    } catch (error) {
      return err(createListenError(error));
    }
  };

  export const safeConnect = async <U extends object, P extends object>(
    context: Context<U, P>,
    targetDescriptor: Partial<U>,
    handlers: PortProcessorHandlers,
  ): Promise<
    Result<
      [PortProcessor.Context, P],
      NexusEndpointCapabilityError | NexusEndpointConnectError
    >
  > => {
    if (!context.endpoint.connect) {
      const capabilityError = new NexusEndpointCapabilityError(
        "Cannot connect: endpoint does not implement connect() method",
        {
          endpointType: "endpoint",
          targetDescriptor,
        },
      );

      return err(capabilityError);
    }

    let connectPromise: Promise<[IPort, P]>;
    try {
      connectPromise = context.endpoint.connect(targetDescriptor);
    } catch (error) {
      return err(
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

    const connected = await Result.tryPromise({
      try: () => connectPromise,
      catch: (error) =>
        new NexusEndpointConnectError(
          `Failed to connect endpoint: ${error instanceof Error ? error.message : String(error)}`,
          {
            endpointType: "endpoint",
            targetDescriptor,
            originalError: error,
          },
        ),
    });
    if (connected.isErr()) {
      return err(connected.error);
    }

    try {
      const [port, platformMetadata] = connected.value;
      return ok([
        PortProcessor.create(port, context.serializer, handlers),
        platformMetadata,
      ]);
    } catch (error) {
      return err(
        new NexusEndpointConnectError(
          `Failed to construct endpoint port: ${error instanceof Error ? error.message : String(error)}`,
          {
            endpointType: "endpoint",
            targetDescriptor,
            originalError: error,
          },
        ),
      );
    }
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

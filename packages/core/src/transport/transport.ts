import type { IEndpoint } from "./types/endpoint";
import type { IPort } from "./types/port";
import { PortProcessor, type PortProcessorHandlers } from "./port-processor";
import { JsonSerializer } from "./serializers/json-serializer";
import { BinarySerializer } from "./serializers/binary-serializer";
import type { ISerializer } from "./serializers/interface";
import type {
  AdapterModel,
  ConnectionTargetOf,
  ConnectionMetaOf,
} from "@/types/adapter-model";
import {
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
  NexusEndpointListenError,
} from "../errors/transport-errors";
import { Result } from "better-result";
const { err, ok } = Result;

export namespace Transport {
  const shouldUseBinarySerializer = <M extends AdapterModel>(
    endpoint: IEndpoint<M>,
  ): boolean => {
    return (
      endpoint.capabilities?.binaryPackets ??
      endpoint.capabilities?.supportsTransferables === true
    );
  };

  export interface Context<M extends AdapterModel> {
    readonly endpoint: IEndpoint<M>;
    readonly serializer: ISerializer;
  }

  /** Select the endpoint's packet codec without starting a listener or connection. */
  export const create = <M extends AdapterModel>(
    endpoint: IEndpoint<M>,
  ): Context<M> => ({
    endpoint,
    serializer: shouldUseBinarySerializer(endpoint)
      ? BinarySerializer.serializer
      : JsonSerializer.serializer,
  });

  /**
   * Start endpoint listening and deliver a processor factory for each accepted port.
   * The result covers listener startup, not later peer handshakes. Client-only
   * endpoints without listen succeed without starting a listener.
   */
  export const safeListen = async <M extends AdapterModel>(
    context: Context<M>,
    onConnect: (
      createProcessor: (
        handlers: PortProcessorHandlers,
      ) => PortProcessor.Context,
      connectionMeta: ConnectionMetaOf<M>,
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
        (port: IPort, connectionMeta: ConnectionMetaOf<M>) => {
          const createProcessor = (
            handlers: PortProcessorHandlers,
          ): PortProcessor.Context =>
            PortProcessor.create(port, context.serializer, handlers);
          try {
            onConnect(createProcessor, connectionMeta);
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

  /**
   * Dial an exact adapter target and synchronously subscribe the returned processor.
   * Converts endpoint/setup exceptions to Err. Does not impose a timeout or perform
   * the Nexus handshake; callers own cancellation and disposal of late results.
   */
  export const safeConnect = async <M extends AdapterModel>(
    context: Context<M>,
    target: ConnectionTargetOf<M>,
    handlers: PortProcessorHandlers,
  ): Promise<
    Result<
      {
        portProcessor: PortProcessor.Context;
        connectionMeta: ConnectionMetaOf<M>;
      },
      NexusEndpointCapabilityError | NexusEndpointConnectError
    >
  > => {
    if (!context.endpoint.connect) {
      const capabilityError = new NexusEndpointCapabilityError(
        "Cannot connect: endpoint does not implement connect() method",
        {
          endpointType: "endpoint",
          target,
        },
      );

      return err(capabilityError);
    }

    return Result.tryPromise({
      try: async () => {
        const { port, connectionMeta } =
          await context.endpoint.connect!(target);
        return {
          portProcessor: PortProcessor.create(
            port,
            context.serializer,
            handlers,
          ),
          connectionMeta,
        };
      },
      catch: (error) => createConnectError(error, target),
    });
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

const createConnectError = <M extends AdapterModel>(
  error: unknown,
  target: ConnectionTargetOf<M>,
): NexusEndpointCapabilityError | NexusEndpointConnectError =>
  error instanceof NexusEndpointCapabilityError ||
  error instanceof NexusEndpointConnectError
    ? error
    : new NexusEndpointConnectError(
        `Failed to connect endpoint: ${error instanceof Error ? error.message : String(error)}`,
        {
          endpointType: "endpoint",
          target,
          originalError: error,
        },
      );

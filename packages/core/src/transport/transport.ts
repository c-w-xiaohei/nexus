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
import { toSerializedError } from "../utils/error";
import { Result } from "better-result";
const { err, ok } = Result;

export namespace Transport {
  export interface Context<M extends AdapterModel> {
    readonly endpoint: IEndpoint<M>;
    readonly serializer: ISerializer;
  }

  /** Select the endpoint's packet codec without starting a listener or connection. */
  export const create = <M extends AdapterModel>(
    endpoint: IEndpoint<M>,
  ): Context<M> => ({
    endpoint,
    serializer:
      (endpoint.capabilities?.binaryPackets ??
      endpoint.capabilities?.supportsTransferables === true)
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
      await context.endpoint.listen(
        (port: IPort, connectionMeta: ConnectionMetaOf<M>) => {
          /** Binds the accepted port to its selected codec before protocol handlers attach. */
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
      return ok(undefined);
    } catch (error) {
      return err(
        new NexusEndpointListenError(
          `Failed to start endpoint listener: ${toSerializedError(error).message}`,
          { endpointType: "endpoint", originalError: error },
        ),
      );
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
      return err(
        new NexusEndpointCapabilityError(
          "Cannot connect: endpoint does not implement connect() method",
          {
            endpointType: "endpoint",
            target,
          },
        ),
      );
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

/** Preserves adapter-owned connection errors and adds target diagnostics to unknown failures. */
const createConnectError = <M extends AdapterModel>(
  error: unknown,
  target: ConnectionTargetOf<M>,
): NexusEndpointCapabilityError | NexusEndpointConnectError => {
  if (
    error instanceof NexusEndpointCapabilityError ||
    error instanceof NexusEndpointConnectError
  )
    return error;
  const originalError = toSerializedError(error);
  return new NexusEndpointConnectError(
    `Failed to connect endpoint: ${originalError.message}`,
    {
      context: { endpointType: "endpoint", target, originalError: error },
      cause: { ...originalError, context: { originalError } },
    },
  );
};

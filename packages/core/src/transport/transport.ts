import type { IEndpoint } from "./types/endpoint";
import type { IPort } from "./types/port";
import { PortProcessor, type PortProcessorHandlers } from "./port-processor";
import { JsonSerializer } from "./serializers/json-serializer";
import { BinarySerializer } from "./serializers/binary-serializer";
import type { ISerializer } from "./serializers/interface";
import { NexusEndpointCapabilityError } from "../errors/transport-errors";

/**
 * The main entry point and facade for Layer 1 (Transport & Protocol).
 * This class orchestrates the creation and management of connections
 * based on a platform-specific `IEndpoint` implementation. It's the
 * single point of contact for Layer 2 (ConnectionManager).
 */
export class Transport<U extends object, P extends object> {
  private readonly endpoint: IEndpoint<U, P>;
  private readonly serializer: ISerializer;

  constructor(endpoint: IEndpoint<U, P>) {
    this.endpoint = endpoint;
    if (this.endpoint.capabilities?.supportsTransferables) {
      this.serializer = new BinarySerializer();
    } else {
      this.serializer = new JsonSerializer();
    }
  }

  /**
   * Starts listening for incoming connections via the configured endpoint.
   * @param onConnect A handler that will be invoked for each new connection.
   *                  It receives a factory function that L2 can use to create
   *                  a `PortProcessor`, and the platform-specific metadata if available.
   */
  public listen(
    onConnect: (
      createProcessor: (handlers: PortProcessorHandlers) => PortProcessor,
      platformMetadata?: P
    ) => void
  ): void {
    if (!this.endpoint.listen) {
      // This is a valid state for a client-only endpoint.
      console.warn(
        "Nexus DEV: `listen` called on an endpoint that does not support it."
      );
      return;
    }

    this.endpoint.listen((port: IPort, platformMetadata?: P) => {
      const createProcessor = (
        handlers: PortProcessorHandlers
      ): PortProcessor => {
        return new PortProcessor(port, this.serializer, handlers);
      };
      onConnect(createProcessor, platformMetadata);
    });
  }

  /**
   * Actively connects to a target via the configured endpoint.
   * @param targetDescriptor The addressing information for the target.
   * @param handlers The handlers to process messages and events for this connection.
   * @returns A Promise that resolves to a tuple containing the `PortProcessor`
   *          for the new connection and the platform-specific metadata of the remote endpoint.
   */
  public async connect(
    targetDescriptor: Partial<U>,
    handlers: PortProcessorHandlers
  ): Promise<[PortProcessor, P]> {
    if (!this.endpoint.connect) {
      throw new NexusEndpointCapabilityError(
        "Cannot connect: endpoint does not implement connect() method",
        { endpointType: this.endpoint.constructor.name, targetDescriptor }
      );
    }
    const [port, platformMetadata] =
      await this.endpoint.connect(targetDescriptor);
    const portProcessor = new PortProcessor(port, this.serializer, handlers);
    return [portProcessor, platformMetadata];
  }
}

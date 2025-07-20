import type { IPort } from "./port";

/**
 * Represents the communication capabilities of the current context and serves
 * as the core of platform-specific adapters. This is the primary interface
 * developers implement to extend Nexus to new JavaScript environments
 * (e.g., WebSockets, Electron Main-Renderer).
 *
 * @template U The user-defined metadata type, injected via `nexus.configure<U, ...>`.
 * @template P The platform-specific metadata type, injected via `nexus.configure<..., P>`.
 */
export interface IEndpoint<U extends object, P extends object> {
  /**
   * (Optional) Starts listening for incoming connection requests.
   * If not implemented, this endpoint cannot accept incoming connections.
   * @param onConnect A callback provided by Layer 2 (ConnectionManager).
   *                  The implementation must call this with a wrapped `IPort`
   *                  instance when a new physical connection is established.
   */
  listen?(onConnect: (port: IPort, platformMetadata?: P) => void): void;

  /**
   * (Optional) Actively initiates a connection to a target.
   * @param targetDescriptor An "addressing descriptor" containing user-defined
   *                         metadata (`Partial<U>`) to identify the target.
   * @returns A Promise that resolves to a tuple containing the `IPort` instance
   *          for the new connection and the discovered `PlatformMetadata` of the remote endpoint.
   */
  connect?(targetDescriptor: Partial<U>): Promise<[IPort, P]>;

  /**
   * (Optional) Identifies the environmental features supported by this Endpoint.
   * @default { supportsTransferables: false }
   */
  capabilities?: {
    /**
     * Whether `postMessage` in this environment supports `Transferable` objects.
     */
    supportsTransferables: boolean;
  };
}

/**
 * Represents a single, established, point-to-point communication channel.
 * This is the lowest-level abstraction for a connection in Nexus,
 * wrapping native connection objects (e.g., `chrome.runtime.Port`, `MessagePort`).
 */
export interface IPort {
  /**
   * Sends a message to the other side of the channel.
   * @param message The message to send.
   * @param transfer An optional array of `Transferable` objects to transfer ownership of.
   */
  postMessage(message: any, transfer?: Transferable[]): void;

  /**
   * Registers a handler to process messages received from the channel.
   * @param handler The function to call with the received message.
   */
  onMessage(handler: (message: any) => void): void;

  /**
   * Registers a handler that is called when the channel is unexpectedly disconnected.
   */
  onDisconnect(handler: () => void): void;

  /**
   * Actively closes the communication channel.
   */
  close(): void;
}

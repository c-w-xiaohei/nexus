/**
 * @file Entry point for the Transport Layer (L1) module.
 *
 * This file exports the public-facing API of the transport layer,
 * including the main `Transport` class and the core interfaces (`IPort`,
 * `IEndpoint`) required for creating platform-specific adapters.
 */

export { Transport } from "./transport.js";
export { VirtualPortRouter } from "./virtual-port/index.js";
export {
  VirtualPortCloseError,
  VirtualPortConnectError,
  VirtualPortListenError,
  VirtualPortProtocolError,
} from "./virtual-port/index.js";
export type { IPort } from "./types/port.js";
export type { IEndpoint } from "./types/endpoint.js";
export type { ISerializer } from "./serializers/interface.js";

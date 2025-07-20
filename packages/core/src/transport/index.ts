/**
 * @file Entry point for the Transport Layer (L1) module.
 *
 * This file exports the public-facing API of the transport layer,
 * including the main `Transport` class and the core interfaces (`IPort`,
 * `IEndpoint`) required for creating platform-specific adapters.
 */

export { Transport } from "./transport";
export type { IPort } from "./types/port";
export type { IEndpoint } from "./types/endpoint";
export type { ISerializer } from "./serializers/interface";

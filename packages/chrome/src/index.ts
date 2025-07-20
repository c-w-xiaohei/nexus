/**
 * Chrome Adapter for Nexus Framework
 * Provides Chrome extension-specific implementations and utilities
 */

// Re-export core Nexus functionality for convenience
export {
  nexus,
  Expose,
  Token,
  type IEndpoint,
  type IPort,
  type NexusConfig,
} from "@nexus/core";

// Chrome-specific exports
export * from "./types/meta";
export * from "./endpoints";
export * from "./factory";
export * from "./matchers";
export * from "./ports/chrome-port";

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
} from "@nexus-js/core";

// Chrome-specific exports
export * from "./types/meta.js";
export * from "./endpoints/index.js";
export * from "./factory.js";
export {
  whereBackground,
  whereContentScript,
  whereContentScriptByOrigin,
  whereContentScriptByUrl,
  whereContentScriptInFrame,
  wherePopup,
  whereVisibleContentScript,
} from "./where.js";
export * from "./ports/chrome-port.js";

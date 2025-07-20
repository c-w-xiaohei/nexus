import { NexusError } from "./nexus-error";

/**
 * Represents an error in the configuration of the Nexus instance.
 * This is thrown synchronously when `nexus.configure()` is called with
 * invalid or incomplete options.
 */
export class NexusConfigurationError extends NexusError {}

/**
 * Represents an error in how a Nexus API is used.
 * For example, calling `nexus.create()` without a clear target.
 */
export class NexusUsageError extends NexusError {}

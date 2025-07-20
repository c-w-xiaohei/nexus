import { NexusError } from "./nexus-error";

/**
 * Represents an error where a requested local resource (e.g., a function
 * or object passed by reference) could not be found.
 */
export class NexusResourceError extends NexusError {}

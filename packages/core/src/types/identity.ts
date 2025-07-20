/**
 * A marker for user-defined metadata. It must be an object type.
 */
export type UserMetadata = object;

/**
 * A marker for platform-specific metadata discovered by an IEndpoint.
 * It must be an object type.
 */
export type PlatformMetadata = object;

/**
 * The business identity of an endpoint, as defined by the user.
 * This is the object that matchers and descriptors operate on for service discovery.
 * e.g., `{ context: 'background', version: '1.0.0' }`
 */
export type EndpointIdentity<U extends UserMetadata> = U;

/**
 * The physical context of a live connection, containing non-forgeable
 * information provided by the platform and the Nexus kernel. This is used
 * primarily for security policies.
 */
export interface ConnectionContext<P extends PlatformMetadata> {
  /**
   * Platform-specific metadata discovered by the L1 Endpoint/Adapter
   * from the underlying transport layer.
   * e.g., `{ tabId: 123, origin: 'https://example.com' }`
   */
  readonly platform: P;

  /** A unique identifier for this specific connection instance. */
  readonly connectionId: string;
}

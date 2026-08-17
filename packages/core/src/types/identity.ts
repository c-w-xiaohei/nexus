/**
 * A marker for user-defined metadata. It must be an object type.
 */
export type ContextMeta = object;

/**
 * A marker for connection metadata discovered by an IEndpoint.
 * It must be an object type.
 */
export type ConnectionMeta = object;

/**
 * A marker for adapter-defined connection acquisition targets. It must be an
 * object type.
 */
export type ConnectionTarget = object;

/**
 * The business identity of an endpoint, as defined by the user.
 * This is the peer-declared identity used by `where` predicates after target
 * selection.
 * e.g., `{ context: 'background', version: '1.0.0' }`
 */
export type EndpointIdentity<U extends ContextMeta> = U;

/**
 * The physical context of a live connection, containing non-forgeable
 * information provided by the platform and the Nexus kernel. This is used
 * primarily for security policies.
 */
export interface ConnectionContext<P extends ConnectionMeta> {
  /**
   * Connection metadata discovered by the L1 Endpoint/Adapter
   * from the underlying transport layer.
   * e.g., `{ tabId: 123, origin: 'https://example.com' }`
   */
  readonly connection: P;

  /** A unique identifier for this specific connection instance. */
  readonly connectionId: string;
}

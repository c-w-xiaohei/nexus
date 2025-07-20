# Layer 2: Connection & Routing

This directory contains the core implementation of Layer 2 of the Nexus architecture. This layer acts as the "network switch" or "traffic control center" of the framework, sitting between the low-level Transport Layer (L1) and the high-level RPC Engine (L3).

## Core Responsibilities

- **Managing Logical Connections**: Abstracting the raw, physical communication channels from L1 into stable, stateful, and identifiable `LogicalConnection` objects. It manages their entire lifecycle from creation to termination.
- **Orchestrating Handshakes**: Implementing a secure handshake protocol to verify the identity of remote endpoints and establish trusted communication channels.
- **Connection Admission Control**: Acting as the second line of defense by enforcing security policies to decide whether to accept or reject incoming connections.
- **Service Discovery & Routing**: Automatically discovering and registering services based on their metadata (`groups`). It routes messages from L3 to a single endpoint (unicast), a service group (multicast), or all matching endpoints (broadcast).
- **Providing a Uniform Interface**: Offering a clean, high-level API to Layer 3 (`RpcEngine`), hiding the complexities of connection management, reuse, and concurrent establishment.

## Architecture

- **`types/`**: Contains the core "contracts" of this layer, defining the configuration objects (`ConnectionManagerConfig`), handler interfaces (`ConnectionManagerHandlers`), and connection resolution options (`ResolveOptions`) that govern its behavior.
- **`LogicalConnection`**: A fundamental class that encapsulates all state and logic for a single point-to-point connection. It's responsible for managing the connection's state (e.g., `HANDSHAKING`, `CONNECTED`), executing the handshake protocol, and serving as the bridge to a specific L1 `PortProcessor`.
- **`ConnectionManager`**: The main facade and orchestrator of this layer. It is instantiated with an L1 `Transport` and provides the core API for L3. It manages the pool of all active `LogicalConnection`s, handles connection reuse, maintains a registry of service groups for routing, and coordinates the entire connection lifecycle.

## API for Layer 3

The `ConnectionManager` class serves as the facade for this layer. It provides the following API to the `Engine` (L3):

### Methods (L3 -> L2)

- **`initialize()`**: Starts the entire connection layer, begins listening for incoming connections, and establishes any pre-configured "warm" connections (`connectTo`).
- **`resolveConnection(options)`**: The primary method for L3 to acquire a connection. It implements a "find-or-create" logic, allowing L3 to get a connection to a specific target by using a `descriptor` or a `matcher`. This is the foundation for `nexus.create()`.
- **`sendMessage(target, message)`**: Routes a `NexusMessage` to its destination. L3 uses this to send RPC calls, results, and other messages without needing to know about the underlying connection details. The `target` can be a specific connection, a service group, or a dynamic matcher.

### Handlers (L2 -> L3)

The `ConnectionManager` communicates events back to L3 via a `handlers` object provided during its construction:

- **`onMessage(message, connectionId)`**: Forwards a fully validated, inbound `NexusMessage` from a specific connection to L3 for processing.
- **`onDisconnect(connectionId, identity)`**: Notifies L3 that a connection has been terminated. This is crucial for L3 to perform resource cleanup (e.g., releasing remote proxies and pending calls).



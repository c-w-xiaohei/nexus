# Layer 2: Connection & Routing

This directory contains the core implementation of Layer 2 of the Nexus architecture. This layer acts as the "network switch" or "traffic control center" of the framework, sitting between the low-level Transport Layer (L1) and the high-level RPC Engine (L3).

## Core Responsibilities

- **Managing Logical Connections**: Abstracting the raw, physical communication channels from L1 into stable, stateful, and identifiable `LogicalConnection` objects. It manages their entire lifecycle from creation to termination.
- **Orchestrating Handshakes**: Implementing a secure handshake protocol to verify the identity of remote endpoints and establish trusted communication channels.
- **Connection Admission Control**: Acting as the second line of defense by enforcing security policies to decide whether to accept or reject incoming connections.
- **Provider Catalog & Routing**: Tracking advertised service IDs for synchronous L4 `get` checks and sending L3 messages over their already-bound sessions. Actual service objects remain in L3.
- **Connection Mechanisms**: Offering explicit target acquisition to L4 and session-bound sending to L3. L4 owns acquisition predicates, cardinality, timeout, and cancellation.

## Architecture

- **`types.ts`**: Defines `ConnectionManagerConfig`, session/manager handlers, and explicit-target `ResolveOptions`.
- **`LogicalConnection`**: A fundamental class that encapsulates all state and logic for a single point-to-point connection. It's responsible for managing the connection's state (e.g., `HANDSHAKING`, `CONNECTED`), executing the handshake protocol, and serving as the bridge to a specific L1 `PortProcessor`.
- **`ConnectionManager`**: The main facade and orchestrator of this layer. It is instantiated with an L1 `Transport` and provides the core API for L3. It manages the pool of all active `LogicalConnection`s, handles connection reuse, and coordinates the entire connection lifecycle.

## API for L4 and L3

L4 initializes and acquires sessions; L3 executes messages on them.

### Methods

- **`safeInitialize()`**: Starts listening, then launches optional exact `connectTo` startup dials once. It does not await the dials or any remote Token; failures are logged without failing local readiness. Demand acquisition shares the same in-flight target slot.
- **`safeResolveConnections({ target })`**: Reuses ready address matches or shares one adapter dial. It requires a target; L4 applies caller predicates afterward, without redialing on mismatch.
- **`findReadyConnections(where?)`**: Synchronously scans current ready sessions. L4 builds passive waiting and fixed snapshots on this operation.
- **`subscribeAvailabilityChanged(listener)`**: Notifies initial session publication and accepted identity updates. Closure and provider catalog updates do not wake connection acquisition.
- **`safeSendMessage(connectionId, message)`**: Routes a `NexusMessage` to one published connection. L3 uses this to send RPC calls, results, and other messages without needing to know about the underlying connection details.

### Handlers (L2 -> L3)

The L4 kernel supplies handlers when constructing the manager:

- **`onMessage(message, connectionId)`**: Forwards a fully validated, inbound `NexusMessage` from a specific connection to L3 for processing.
- **`onDisconnect(connectionId)`**: Runs required L3 cleanup after the session leaves L2 indexes. It is an ordered command, not a lifecycle broadcast.

On disconnect, L2 removes session indexes first, the kernel invokes L3 cleanup,
and only then does LogicalConnection notify its own disconnect subscribers.
Public Connection handles register live listeners directly with the session;
they add public replay behavior without another channel or rebroadcast layer.
Nexus onConnect subscribes directly to manager collection changes after bootstrap.
Manager registers each published session, subscribes to identity changes and
publishes initial availability explicitly. Session events report changes only;
the public Connection handle owns current-value and late-terminal replay.

# Layer 1: Transport & Protocol

This directory contains the core implementation of Layer 1 of the Nexus architecture.

## Core Responsibilities

- **Abstracting Platforms**: To hide platform-specific IPC (Inter-Process Communication) details behind standard interfaces.
- **Protocol Implementation**: To handle serialization and deserialization. Message chunking remains a TODO; current transports send whole packets.
- **Providing a Uniform Interface**: To offer a clean, unified service to Layer 2 (`ConnectionManager`), regardless of the underlying environment.

## Architecture

- **`types/`**: Contains the core "contracts" of this layer.
  - `IPort`: The lowest-level abstraction for a point-to-point communication channel.
  - `IEndpoint`: The interface that platform adapters must implement. This is the sole entry point for extending Nexus to new environments.
- **`serializers/`**: Contains the logic for converting logical `NexusMessage` objects into transmittable data packets and back. It includes `JsonSerializer` for compact JSON packet strings and `BinarySerializer` for the same compact JSON packet encoded as a UTF-8 `ArrayBuffer`.
- **`PortProcessor`**: A closure factory that wraps a raw `IPort`. It handles serialization and native send/close errors for a single connection, ensuring higher layers only deal with logical messages. Chunk options are reserved and currently have no effect.
- **`Transport`**: A namespace with a context created from an `IEndpoint`. Its `safeListen` and `safeConnect` functions create `PortProcessor` instances for Layer 2.

## API for Layer 2

The `Transport` namespace provides the following API to the `ConnectionManager` (L2):

- **`safeListen(context, onConnect)`**: Puts the underlying endpoint into a listening state and returns a result.
  - `onConnect(createProcessor, connectionMeta)`: A callback invoked by `Transport` for each new incoming physical connection. Layer 2 uses the `createProcessor` function to create a `PortProcessor` for the new connection, which bridges L1 and L2.

- **`safeConnect(context, target, handlers)`**: Actively initiates a new physical connection to a remote endpoint.
  - It returns a `Promise<Result>` containing a new `PortProcessor` and the adapter's local connection metadata. Layer 2 uses this processor to manage the new outbound connection.

## Benchmarking

Run `pnpm perf:bench` from the repository root to compare UTF-8 JSON and
MessagePack over real Node IPC RPC between separate processes. Both codecs use
the same validated Nexus packet shape and workloads. The script alternates run
order and reports median successful RPC/s, p99 latency, and the range of paired
throughput changes. The alternative serializer is installed only by benchmark
processes; normal Nexus connections retain their existing codec.

Set `NEXUS_BENCH_PAIRS`, `NEXUS_BENCH_SECONDS`, and
`NEXUS_BENCH_WARMUP_SECONDS` to adjust duration. These Node-only results do not
measure browser transports. The benchmark is opt-in and does not run in
`pnpm test` or CI.

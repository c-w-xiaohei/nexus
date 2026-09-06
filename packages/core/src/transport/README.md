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

## Serializer Reality And Benchmarking

`BinarySerializer` is not currently MessagePack. It calls `JsonSerializer.safeSerialize()` to produce the compact Nexus packet array JSON string, then UTF-8 encodes that string into an `ArrayBuffer`. This is useful for transports that require binary packet boundaries, including Node IPC framing, but it does not provide the size or CPU profile of a real binary codec.

The serializer benchmark scaffold lives in `serializers/serializer-benchmark.ts` and is runnable after build with:

```bash
pnpm benchmark:serializers
```

The scaffold intentionally uses Nexus message shapes rather than generic object samples: small `GET`/`APPLY`, nested `APPLY`, small and large `RES`, `ERR`, `BATCH` with 10 and 100 calls, `HANDSHAKE_REQ`, `HANDSHAKE_ACK`, and a binary-payload-shaped response. It reports encoded byte length plus encode, decode, and encode+decode roundtrip timings for the current `JsonSerializer` and `BinarySerializer`.

MessagePack remains a codec decision candidate, not the current implementation. `msgpackr` and `@msgpack/msgpack` should be added to this scaffold only when the project is ready to evaluate their dependency, bundle, CSP, and Node/browser tradeoffs. If those candidates show clear wins for common Nexus payloads, `BinarySerializer` can evolve to a MessagePack-backed implementation; otherwise the current compact JSON `ArrayBuffer` implementation should stay documented as such.

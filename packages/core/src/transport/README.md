# Layer 1: Transport & Protocol

This directory contains the core implementation of Layer 1 of the Nexus architecture.

## Core Responsibilities

- **Abstracting Platforms**: To hide platform-specific IPC (Inter-Process Communication) details behind standard interfaces.
- **Protocol Implementation**: To handle the serialization, deserialization, and transparent management of advanced protocol features like message chunking.
- **Providing a Uniform Interface**: To offer a clean, unified service to Layer 2 (`ConnectionManager`), regardless of the underlying environment.

## Architecture

- **`types/`**: Contains the core "contracts" of this layer.
  - `IPort`: The lowest-level abstraction for a point-to-point communication channel.
  - `IEndpoint`: The interface that platform adapters must implement. This is the sole entry point for extending Nexus to new environments.
- **`serializers/`**: Contains the logic for converting logical `NexusMessage` objects into transmittable data packets and back. It includes `JsonSerializer` for compact JSON packet strings and `BinarySerializer` for the same compact JSON packet encoded as a UTF-8 `ArrayBuffer`.
- **`PortProcessor`**: A crucial class that wraps a raw `IPort`. It orchestrates serialization and protocol handling (like chunking) for a single connection, ensuring higher layers only deal with logical messages.
- **`Transport`**: The main facade of this layer. It is instantiated with an `IEndpoint` and provides `listen` and `connect` methods for Layer 2 to use, creating and managing `PortProcessor` instances internally.

## API for Layer 2

The `Transport` class serves as the facade for this layer. It provides the following API to the `ConnectionManager` (L2):

- **`listen(onConnect)`**: Puts the underlying endpoint into a listening state.
  - `onConnect(createProcessor, platformMeta)`: A callback invoked by `Transport` for each new incoming physical connection. Layer 2 uses the `createProcessor` function to create a `PortProcessor` for the new connection, which bridges L1 and L2.

- **`connect(target, handlers)`**: Actively initiates a new physical connection to a remote endpoint.
  - It returns a `Promise` that resolves with a new `PortProcessor` instance and the remote endpoint's platform metadata. Layer 2 uses this `PortProcessor` to manage the new outbound connection.

## Serializer Reality And Benchmarking

`BinarySerializer` is not currently MessagePack. It calls `JsonSerializer.safeSerialize()` to produce the compact Nexus packet array JSON string, then UTF-8 encodes that string into an `ArrayBuffer`. This is useful for transports that require binary packet boundaries, including Node IPC framing, but it does not provide the size or CPU profile of a real binary codec.

The serializer benchmark scaffold lives in `serializers/serializer-benchmark.ts` and is runnable after build with:

```bash
pnpm benchmark:serializers
```

The scaffold intentionally uses Nexus message shapes rather than generic object samples: small `GET`/`APPLY`, nested `APPLY`, small and large `RES`, `ERR`, `BATCH` with 10 and 100 calls, `HANDSHAKE_REQ`, `HANDSHAKE_ACK`, and a binary-payload-shaped response. It reports encoded byte length plus encode, decode, and encode+decode roundtrip timings for the current `JsonSerializer` and `BinarySerializer`.

MessagePack remains a codec decision candidate, not the current implementation. `msgpackr` and `@msgpack/msgpack` should be added to this scaffold only when the project is ready to evaluate their dependency, bundle, CSP, and Node/browser tradeoffs. If those candidates show clear wins for common Nexus payloads, `BinarySerializer` can evolve to a MessagePack-backed implementation; otherwise the current compact JSON `ArrayBuffer` implementation should stay documented as such.

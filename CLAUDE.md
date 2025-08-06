# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a monorepo for the Nexus framework, a type-safe, default-safe cross-context communication framework for JavaScript environments like Chrome Extensions, Electron applications, Web Workers, and iframes. It uses pnpm workspaces and Turbo for build management.

Nexus abstracts away the complexities of underlying communication channels, allowing you to focus on your application's business logic through a unified API (`nexus` singleton) across different platforms.

## Repository Structure

- `packages/core` - The core engine for Nexus framework
- `packages/chrome` - Chrome extension adapter for Nexus
- `packages/state` - State management utilities (appears to be present but not fully explored)

## Key Development Commands

### Install dependencies
```bash
pnpm install -w
```

### Build the project
```bash
pnpm build
```

### Run tests
```bash
pnpm test
```

### Run linting
```bash
pnpm lint
```

### Development mode
```bash
pnpm dev
```

### Format code
```bash
pnpm format
```

## Architecture Overview

### Core Concepts
1. **Unified Abstraction**: A single, consistent API (`nexus` singleton) across different platforms
2. **Declarative APIs**: Use decorators (`@Expose`, `@Endpoint`) and fluent configuration (`.configure()`) to define communication intent
3. **End-to-end Type Safety**: Leveraging TypeScript to provide robust compile-time checks
4. **Robust Resource Management**: Handles the lifecycle of remote resources and connections automatically
5. **Familiar Paradigms**: Nexus maps cross-context communication to intuitive local programming concepts: `@Expose` for exporting a service, `nexus.create` for constructing a remote service instance, and `Token` as its unique identifier

### Key Components

#### Token System
- `Token<T>` - A type-safe identifier for services at runtime, separating "compile-time shape" from "runtime identity"
- `TokenSpace` - Factory and namespace manager for creating and organizing Tokens with hierarchical naming and default target inheritance

#### Decorators
- `@Expose(token)` - Decorator to mark a class as an exposed service that can be called remotely
- `@Endpoint` - Decorator to define an endpoint for communication (implementation detail, typically used by adapters)

#### Factories
- Platform-specific factory functions like `usingBackgroundScript()`, `usingContentScript()` for streamlined setup in Chrome extensions

#### Adapters
- `@nexus/chrome-adapter` - Chrome extension specific adapter providing implementations for different extension contexts

### Communication Architecture (Layers)

#### Layer 1 - Transport & Protocol (`/transport`)
- Handles the underlying communication channels (e.g., Chrome extension ports, postMessage)
- Manages serialization (JSON/Binary) and message passing
- Abstraction over platform-specific communication mechanisms

#### Layer 2 - Connection & Routing (`/connection`)
- `ConnectionManager` - Main orchestrator that handles connection lifecycle from discovery to routing
- `LogicalConnection` - Manages the logical connection between endpoints
- Connection handshake, verification, and routing of messages between connections

#### Layer 3 - Service & Proxy (`/service`)
- `Engine` - Central orchestrator that manages RPC calls
- `ProxyFactory` - Creates service proxies that enable remote method calls
- `ResourceManager` - Manages exposed services and remote resource references
- `CallProcessor` - Processes remote method calls and handles the request/response cycle

#### Layer 4 - Application Interface (Public API)
- `nexus` singleton - Main entry point for all application interactions
- `nexus.create()` - Creates proxies to remote services
- `nexus.createMulticast()` - Creates proxies for calling multiple services simultaneously
- `nexus.configure()` - Configures the Nexus instance with endpoints, matchers, etc.

### Communication Flow
1. Services are exposed in one context using `@Expose` decorator
2. Services are consumed in another context using `nexus.create()` with a token
3. Automatic connection management between contexts
4. Type-safe remote procedure calls across contexts with automatic serialization/deserialization
5. Bidirectional communication with proper resource cleanup

## Core Implementation Details

### Nexus Singleton
The `nexus` singleton (an instance of the `Nexus` class) is the main API entry point:
- Provides unified configuration through `configure()`
- Creates service proxies with `create()` and `createMulticast()`
- Manages connection resolution and targeting
- Handles metadata updates with `updateIdentity()`
- Provides utilities like `ref()` and `release()`

### Token System
Tokens are created within `TokenSpace` instances, which provide:
- Hierarchical namespacing for organized token IDs
- Default target configuration inheritance
- Type-safe service identification

### Service Exposure
Services are exposed using the `@Expose` decorator:
- Applied to classes that implement service interfaces
- Associates the class with a specific `Token`
- Supports dependency injection through factory functions
- Integrated with authorizaton policies

### Connection Management
The `ConnectionManager` handles:
- Connection discovery and establishment
- Logical connection lifecycle (handshake, verification, closure)
- Message routing to appropriate connections
- Metadata updates and broadcasting
- Service grouping for multicast operations

### Message Processing
The system supports various message types:
- Service method calls (GET, SET, APPLY)
- Response handling with promise resolution
- Error propagation across contexts
- Resource management with reference counting
- Stream-like operations for multicast scenarios

## Chrome Extension Specifics

The `@nexus/chrome-adapter` provides ready-to-use factory functions for common Chrome extension contexts:
- `usingBackgroundScript()` - For background scripts
- `usingContentScript()` - For content scripts with automatic visibility tracking
- `usingPopup()`, `usingOptionsPage()`, `usingDevToolsPage()`, `usingOffscreenDocument()` - For various UI contexts

These factories provide:
- Pre-configured endpoints for each context
- Named matchers for common targeting scenarios
- Default descriptors for easy connection establishment
- Context-specific metadata

## Testing

Tests are written using Vitest and can be run with coverage reporting:

```bash
pnpm test
```

Individual package tests can be run with:
```bash
pnpm test --filter=@nexus/core
pnpm test --filter=@nexus/chrome-adapter
```

## Package Management

This project uses pnpm workspaces with the following key packages:
- `@nexus/core` - Core framework functionality
- `@nexus/chrome-adapter` - Chrome extension specific adapter

Packages are built using Vite with TypeScript and output to `dist/` directories.

The monorepo is managed with Turbo for efficient builds and task execution.
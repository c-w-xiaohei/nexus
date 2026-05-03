# @nexus-js/core

## 0.2.0

### Minor Changes

- e029932: Add the iframe adapter package and public transport subpaths for adapter authors, including virtual-port routing over message-bus transports.
- 48aaab9: Add `@nexus-js/core/relay` with `relayService` and `relayNexusStore`, and extend Nexus State/store invocation context and terminal sync handling needed for relay-backed forwarding.

## 0.1.2

### Patch Changes

- e84c367: Release the initial public Node IPC adapter package and update core runtime capabilities that support adapter authorization and connection hardening.

  Core now includes authorization policy hooks, a split between listen and connect capabilities, async listen support with handshake timeouts, and public/internal API updates for serializer benchmarks and dependencies.

## 0.1.1

### Patch Changes

- acd681a: fix dep
- 03021e8: initial publish

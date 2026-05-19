# @nexus-js/node-ipc

## 0.2.0

### Minor Changes

- e029932: Add the iframe adapter package and public transport subpaths for adapter authors, including virtual-port routing over message-bus transports.

### Patch Changes

- 6bfd5b8: Add token create defaults, instance-bound class decorators, provider registration lifecycle APIs, and updated public usage guidance for the new configure/provide/create model.
- Updated dependencies [e029932]
- Updated dependencies [48aaab9]
- Updated dependencies [6bfd5b8]
  - @nexus-js/core@0.2.0

## 0.1.2

### Patch Changes

- e84c367: Release the initial public Node IPC adapter package and update core runtime capabilities that support adapter authorization and connection hardening.

  Core now includes authorization policy hooks, a split between listen and connect capabilities, async listen support with handshake timeouts, and public/internal API updates for serializer benchmarks and dependencies.

- Updated dependencies [e84c367]
  - @nexus-js/core@0.1.2

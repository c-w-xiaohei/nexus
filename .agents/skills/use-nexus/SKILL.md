---
name: use-nexus
description: This skill should be used when the user asks to write Nexus application code, configure Nexus adapters, define Nexus service contracts or Tokens, expose services, create proxies with nexus.create, or document external Nexus usage patterns.
version: 0.1.0
---

# Use Nexus

Use this skill for external application code that consumes Nexus. Focus on the public programming model: shared contracts, typed Tokens, runtime configuration, service exposure, and proxy creation.

For full project documentation, read the `docs/` directory in `c-w-xiaohei/nexus`.

## Core Rules

- Keep service contracts and Tokens in shared code imported by every context that needs them.
- Prefer `TokenSpace` when an app needs structured token IDs or default target inheritance.
- Import existing service types instead of redefining service shapes inline.
- Configure every runtime context before creating proxies or exposing services.
- Prefer adapter helpers such as `usingBackgroundScript(...)`, `usingContentScript(...)`, `usingNodeIpcDaemon(...)`, and `usingNodeIpcClient(...)` for standard runtimes.
- Use `nexus.configure(...)` for explicit endpoint configuration, service registration, policy, matchers, descriptors, or adapter config composition.
- Use `new Nexus()` plus explicit `configure({ endpoint, services })` for multi-instance runtimes; do not use `@Expose` or `@Endpoint` decorators there because decorator registration is process-global.
- Pass an options object to `nexus.create(...)`; provide an explicit `target` unless a Token default target or unique `connectTo` fallback is intentionally being used.
- Treat raw `nexus.create(...)` proxies and refs as session-bound handles. Recreate them after disconnect, restart, or session replacement.

## Minimal Example

Shared contract:

```ts
import { TokenSpace } from "@nexus-js/core";
import type { AppPlatformMeta, AppUserMeta } from "./runtime-types";

export interface PingService {
  ping(input: string): Promise<string>;
}

const appSpace = new TokenSpace<AppUserMeta, AppPlatformMeta>({
  name: "my-app",
});

const services = appSpace.tokenSpace("services", {
  defaultTarget: {
    descriptor: { context: "host" },
  },
});

export const PingToken = services.token<PingService>("ping");
```

Host context:

```ts
import { Expose } from "@nexus-js/core";
import { usingHostRuntime } from "@nexus-js/some-adapter";
import { PingToken, type PingService } from "./shared";

usingHostRuntime();

@Expose(PingToken)
class PingServiceImpl implements PingService {
  async ping(input: string) {
    return `pong:${input}`;
  }
}
```

Consumer context:

```ts
import { nexus } from "@nexus-js/core";
import { usingClientRuntime } from "@nexus-js/some-adapter";
import { PingToken } from "./shared";

usingClientRuntime();

const ping = await nexus.create(PingToken, {
  target: {
    descriptor: { context: "host" },
  },
});

await ping.ping("hello");
```

## When More Detail Is Needed

Read `references/usage-style.md` for the complete external usage style, including:

- shared contract and TokenSpace conventions
- adapter helper versus `nexus.configure(...)` usage
- `nexus.create(...)` targeting patterns
- multi-instance runtime guidance and decorator limitations
- node-ipc configuration composition
- policy and authorization style
- lifecycle expectations

Also read repository docs under `c-w-xiaohei/nexus/docs`, especially:

- `docs/getting-started.md`
- `docs/concepts.md`
- `docs/platforms.md`
- adapter-specific docs such as `docs/node-ipc/README.md`

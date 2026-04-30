import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Nexus, Token } from "@nexus-js/core";
import type { NexusInstance } from "@nexus-js/core";
import { usingNodeIpcClient, usingNodeIpcDaemon } from "./factory";
import { UnixSocketServerEndpoint } from "./endpoints/unix-socket-server";
import type { NodeIpcSocketAddress } from "./types/address";
import type { NodeIpcPlatformMeta, NodeIpcUserMeta } from "./types/meta";

export type EchoService = {
  echo(input: string): string;
  fail?(message: string): void;
};

export const EchoToken = new Token<EchoService>("node-ipc-test.echo");

export type TestHarness = {
  root: string;
  address: NodeIpcSocketAddress;
  startDaemon(options?: {
    authToken?: string;
    policy?: Parameters<typeof usingNodeIpcDaemon>[0]["policy"];
    service?: EchoService;
  }): Promise<{
    daemon: NexusInstance<NodeIpcUserMeta, NodeIpcPlatformMeta>;
    close(): void;
  }>;
  createClient(options?: {
    authToken?: string;
    policy?: Parameters<typeof usingNodeIpcClient>[0]["policy"];
  }): NexusInstance<NodeIpcUserMeta, NodeIpcPlatformMeta>;
  cleanup(): Promise<void>;
};

export async function createHarness(): Promise<TestHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-node-ipc-"));
  const address = {
    kind: "path",
    path: path.join(root, "daemon.sock"),
  } satisfies NodeIpcSocketAddress;

  return {
    root,
    address,
    async startDaemon(options = {}) {
      const endpoint = new UnixSocketServerEndpoint(address, options.authToken);
      const daemon = new Nexus<NodeIpcUserMeta, NodeIpcPlatformMeta>();
      const config = {
        ...usingNodeIpcDaemon({
          appId: "test-daemon",
          address,
          authToken: options.authToken,
          configure: false,
          policy: options.policy,
          services: [
            {
              token: EchoToken,
              implementation:
                options.service ??
                ({
                  echo: (input: string) => input,
                } satisfies EchoService),
            },
          ],
        } as unknown as Parameters<typeof usingNodeIpcDaemon>[0]),
        endpoint: {
          meta: {
            context: "node-ipc-daemon" as const,
            appId: "test-daemon",
            instance: "default",
            pid: process.pid,
          },
          implementation: endpoint,
        },
      };
      daemon.configure(
        config as unknown as Parameters<typeof daemon.configure>[0],
      );
      await waitForSocket(address.path);
      return {
        daemon,
        close() {
          endpoint.close();
        },
      };
    },
    createClient(options = {}) {
      const client = new Nexus<NodeIpcUserMeta, NodeIpcPlatformMeta>();
      const config = usingNodeIpcClient({
        appId: `test-client-${Math.random().toString(16).slice(2)}`,
        authToken: options.authToken,
        configure: false,
        connectTo: [
          {
            descriptor: {
              context: "node-ipc-daemon",
              appId: "test-daemon",
            },
          },
        ],
        policy: options.policy,
        resolveAddress: () => address,
      } as unknown as Parameters<typeof usingNodeIpcClient>[0]);
      client.configure(
        config as unknown as Parameters<typeof client.configure>[0],
      );
      return client;
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const stats = await fs.lstat(socketPath);
      if (stats.isSocket()) return;
    } catch {
      // Retry until Nexus finishes deferred endpoint initialization.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Socket was not created: ${socketPath}`);
}

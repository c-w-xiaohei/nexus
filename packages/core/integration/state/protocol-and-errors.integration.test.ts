import { describe, expect, it } from "vitest";
import { createStarNetwork } from "../../src/utils/test-utils";
import type { TestAdapterModel } from "../../src/utils/test-utils";
import {
  connectNexusStore,
  createStoreToken,
  NexusStoreConnectError,
  NexusStoreProtocolError,
} from "../../src/state";
import type { NexusStoreServiceContract } from "../../src/state/contract";

type State = { count: number };
type Actions = { noop(): number };
type Model = TestAdapterModel<
  { context: "background" | "popup" },
  { from: string }
>;

const token = createStoreToken<State & Actions, Model>("state:protocol");

describe("Nexus State protocol and errors", () => {
  it("classifies malformed callback init and handshake timeout", async () => {
    const malformed = {
      subscribe: async (onSync: (event: unknown) => unknown) =>
        onSync({ type: "init", version: "bad" }),
    };
    const network = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        providers: { [token.id]: malformed },
      },
      leaves: [
        {
          meta: { context: "popup" },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
      ],
    });
    await expect(
      connectNexusStore(network.get("popup")!.nexus, token, {
        target: { context: "background" },
      }),
    ).rejects.toBeInstanceOf(NexusStoreProtocolError);

    const timeout = {
      subscribe: async () => new Promise<void>(() => undefined),
    };
    const timeoutNetwork = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        providers: { [token.id]: timeout },
      },
      leaves: [
        {
          meta: { context: "popup" },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
      ],
    });
    await expect(
      connectNexusStore(timeoutNetwork.get("popup")!.nexus, token, {
        target: { context: "background" },
        timeout: 20,
      }),
    ).rejects.toBeInstanceOf(NexusStoreConnectError);
  });

  it("reports unknown commit when transport closes during an action", async () => {
    const gate = new Promise<void>(() => undefined);
    let started!: () => void;
    const service = {
      subscribe: async (onSync: (event: unknown) => unknown) =>
        onSync({
          type: "init",
          storeInstanceId: "one",
          version: 0,
          state: { count: 0 },
          actions: {
            noop: async () => {
              started();
              await gate;
              return 0;
            },
          },
          unsubscribe: () => undefined,
        }),
    } as unknown as NexusStoreServiceContract<State & Actions>;
    const network = await createStarNetwork<
      { context: "background" | "popup" },
      { from: string }
    >({
      center: {
        meta: { context: "background" },
        providers: { [token.id]: service },
      },
      leaves: [
        {
          meta: { context: "popup" },
          cmConfig: { connectTo: [{ context: "background" }] },
        },
      ],
    });
    const popup = network.get("popup")!.nexus;
    let resolveStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    started = resolveStarted;
    const remote = await connectNexusStore(popup, token, {
      target: { context: "background" },
    });
    const pending = remote.actions.noop();
    await actionStarted;
    const connection = Array.from(
      (popup as any).connectionManager.connections.values(),
    )[0] as {
      close(): void;
    };
    connection.close();
    await expect(pending).rejects.toBeDefined();
  });
});

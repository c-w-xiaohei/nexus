import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { Token } from "./token";
import type { DefaultAdapterModel } from "../types/adapter-model";
import type { IPort } from "../transport/types/port";
import { createMockPortPair } from "../utils/test-utils";
import type { NexusInstance } from "./types";

type LocalModel = {
  contextMeta: { local: string };
  connectionMeta: { localFact: number };
  connectionTarget: { context: "local"; tabId: number };
};
type RemoteModel = {
  contextMeta: { remote: string };
  connectionMeta: { remoteFact: boolean };
  connectionTarget: { context: "remote"; url: string };
};

// Checked by tsc without creating registrations or starting runtimes.
function checkRelayTypes(
  local: NexusInstance<LocalModel>,
  remote: NexusInstance<RemoteModel>,
) {
  const token = new Token<{ read(): string }>("portable");
  local.relay({
    services: [token],
    to: {
      target: { context: "local", tabId: 1 },
      where: (identity, facts) => {
        expectTypeOf(identity).toEqualTypeOf<LocalModel["contextMeta"]>();
        expectTypeOf(facts).toEqualTypeOf<LocalModel["connectionMeta"]>();
        return true;
      },
    },
  });
  local.safeRelay({
    services: [token],
    to: {
      nexus: remote,
      target: { context: "remote", url: "ws://localhost" },
      where: (identity, facts) => {
        expectTypeOf(identity).toEqualTypeOf<RemoteModel["contextMeta"]>();
        expectTypeOf(facts).toEqualTypeOf<RemoteModel["connectionMeta"]>();
        return true;
      },
    },
  });
  // @ts-expect-error A remote target cannot infer a different runtime when nexus is omitted.
  local.relay({
    services: [token],
    to: { target: { context: "remote", url: "ws://localhost" } },
  });
  // @ts-expect-error Explicit runtime controls target typing, not the target object.
  local.relay({
    services: [token],
    to: { nexus: remote, target: { context: "local", tabId: 1 } },
  });
}
void checkRelayTypes;

describe("instance Relay registration", () => {
  it("registers on its owner by default and rejects unsupported upstream implementations", () => {
    const owner = new Nexus<DefaultAdapterModel>();
    const token = new Token<{ read(): string }>("same-runtime");
    const handle = owner.relay({ services: [token], to: {} });
    expect(owner.safeProvide(token, { read: () => "local" }).isErr()).toBe(
      true,
    );
    handle.dispose();
    const invalid = owner.safeRelay({
      services: [token],
      to: { nexus: {} as NexusInstance<DefaultAdapterModel> },
    });
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr())
      expect(invalid.error).toMatchObject({
        code: "E_USAGE_INVALID",
        message: expect.stringContaining("Nexus runtime"),
      });
    expect(owner.safeProvide(token, { read: () => "local" }).isOk()).toBe(true);
  });
  it("contains invalid and hostile configuration at the safe boundary", () => {
    const from = new Nexus<DefaultAdapterModel>();
    const throwing = Object.defineProperty({}, "to", {
      get() {
        throw new Error("hostile");
      },
    });
    expect(() => from.safeRelay(throwing as never)).not.toThrow();
    expect(from.safeRelay(throwing as never).isErr()).toBe(true);
    const to = new Nexus<DefaultAdapterModel>();
    expect(
      from.safeRelay({ to: { nexus: to }, services: Array(1) }).isErr(),
    ).toBe(true);
  });
  it("registers before bootstrap without acquiring an upstream connection", () => {
    const from = new Nexus<DefaultAdapterModel>();
    const to = new Nexus<DefaultAdapterModel>();
    const token = new Token<{ read(): string }>("documents");
    const registration = from.relay({
      to: { nexus: to, target: { context: "provider" } },
      services: [token],
    });
    expect(
      from.safeRelay({ to: { nexus: to }, services: [token] }).isErr(),
    ).toBe(true);
    expect(from.safeProvide(token, { read: () => "local" }).isErr()).toBe(true);
    registration.dispose();
    registration.dispose();
    expect(from.safeProvide(token, { read: () => "local" }).isOk()).toBe(true);
  });

  it("R12 rejects a conflicting batch atomically and an old dispose cannot remove a replacement", () => {
    const from = new Nexus<DefaultAdapterModel>();
    const to = new Nexus<DefaultAdapterModel>();
    const local = new Token<{ read(): string }>("local");
    const first = new Token<{ read(): string }>("first");
    const second = new Token<{ read(): string }>("second");
    from.provide(local, { read: () => "local" });

    expect(
      from
        .safeRelay({
          to: { nexus: to },
          services: [first, local],
        })
        .isErr(),
    ).toBe(true);
    const original = from.relay({
      to: { nexus: to },
      services: [first],
    });
    expect(
      from.safeProvide(first, { read: () => "must-conflict" }).isErr(),
    ).toBe(true);

    original.dispose();
    const replacement = from.relay({
      to: { nexus: to },
      services: [first, second],
    });
    original.dispose();
    expect(
      from.safeProvide(first, { read: () => "must-still-conflict" }).isErr(),
    ).toBe(true);
    replacement.dispose();
    expect(from.safeProvide(first, { read: () => "released" }).isOk()).toBe(
      true,
    );
  });

  it("R12 rejects registration synchronously reentered while bootstrap is listening", async () => {
    const from = new Nexus<DefaultAdapterModel>();
    const to = new Nexus<DefaultAdapterModel>();
    const token = new Token<{ read(): string }>("locked");
    let result: ReturnType<typeof from.safeRelay> | undefined;
    from.configure({
      endpoint: {
        meta: { context: "from" },
        implementation: {
          listen: () => {
            result = from.safeRelay({
              to: { nexus: to },
              services: [token],
            });
          },
        },
      },
    });

    await from.ready();
    expect(result?.isErr()).toBe(true);
    expect(
      from.safeProvide(token, { read: () => "not-published" }).isOk(),
    ).toBe(true);
  });

  it("R12 withdraws and replaces a live peer provider entry", async () => {
    const from = new Nexus<DefaultAdapterModel>();
    const upstream = new Nexus<DefaultAdapterModel>();
    const client = new Nexus<DefaultAdapterModel>();
    const token = new Token<{ read(): Promise<string> }>("live-provider");
    let accept!: (port: IPort, meta: object) => void;
    from.configure({
      endpoint: {
        meta: { context: "from" },
        implementation: {
          listen: (listener) => {
            accept = listener;
          },
          connect: async () => {
            throw new Error("provider directory must not dial upstream");
          },
        },
      },
    });
    const first = from.relay({
      to: { nexus: upstream, target: { context: "upstream" } },
      services: [token],
    });
    await from.ready();
    client.configure({
      endpoint: {
        meta: { context: "client" },
        implementation: {
          listen: () => {},
          connect: async () => {
            const [local, remote] = createMockPortPair();
            accept(remote, {});
            return { port: local, connectionMeta: {} };
          },
        },
      },
    });
    await client.ready();
    const connection = await client.connect({ target: { context: "from" } });
    expect(connection.safeGet(token).isOk()).toBe(true);

    first.dispose();
    await vi.waitFor(() =>
      expect(connection.safeGet(token).isErr()).toBe(true),
    );

    const replacement = from.relay({
      to: { nexus: upstream, target: { context: "upstream" } },
      services: [token],
    });
    await vi.waitFor(() => expect(connection.safeGet(token).isOk()).toBe(true));
    replacement.dispose();
    connection.disconnect();
  });
});

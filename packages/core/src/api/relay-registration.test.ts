import { describe, expect, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { Token } from "./token";
import type { DefaultAdapterModel } from "../types/adapter-model";
import type { IPort } from "../transport/types/port";
import { createMockPortPair } from "../utils/test-utils";

describe("Nexus.relay registration", () => {
  it("contains invalid and hostile configuration at the safe boundary", () => {
    const throwing = Object.defineProperty({}, "from", {
      get() {
        throw new Error("hostile");
      },
    });
    expect(() => Nexus.safeRelay(throwing as never)).not.toThrow();
    expect(Nexus.safeRelay(throwing as never).isErr()).toBe(true);
    const from = new Nexus<DefaultAdapterModel>();
    const to = new Nexus<DefaultAdapterModel>();
    expect(
      Nexus.safeRelay({ from, to: { nexus: to }, services: Array(1) }).isErr(),
    ).toBe(true);
  });
  it("registers before bootstrap without acquiring an upstream connection", () => {
    expect(typeof Nexus.relay).toBe("function");
    const from = new Nexus<DefaultAdapterModel>();
    const to = new Nexus<DefaultAdapterModel>();
    const token = new Token<{ read(): string }>("documents");
    const registration = Nexus.relay({
      from,
      to: { nexus: to, target: { context: "provider" } },
      services: [token],
    });
    expect(
      Nexus.safeRelay({ from, to: { nexus: to }, services: [token] }).isErr(),
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
      Nexus.safeRelay({
        from,
        to: { nexus: to },
        services: [first, local],
      }).isErr(),
    ).toBe(true);
    const original = Nexus.relay({
      from,
      to: { nexus: to },
      services: [first],
    });
    expect(
      from.safeProvide(first, { read: () => "must-conflict" }).isErr(),
    ).toBe(true);

    original.dispose();
    const replacement = Nexus.relay({
      from,
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
    let result: ReturnType<typeof Nexus.safeRelay> | undefined;
    from.configure({
      endpoint: {
        meta: { context: "from" },
        implementation: {
          listen: () => {
            result = Nexus.safeRelay({
              from,
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
    const first = Nexus.relay({
      from,
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

    const replacement = Nexus.relay({
      from,
      to: { nexus: upstream, target: { context: "upstream" } },
      services: [token],
    });
    await vi.waitFor(() => expect(connection.safeGet(token).isOk()).toBe(true));
    replacement.dispose();
    connection.disconnect();
  });
});

import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { Token } from "./token";
import type { RefWrapper } from "../types/ref-wrapper";
import type { IPort } from "../transport/types/port";
import type { DefaultAdapterModel } from "../types/adapter-model";

function port(
  native: MessagePort,
  afterPost?: (message: unknown) => void,
): IPort {
  return {
    postMessage: (message, transfer, signal) => {
      if (signal?.aborted) throw new Error("aborted");
      native.postMessage(message, transfer as ArrayBuffer[]);
      afterPost?.(message);
    },
    onMessage: (handler) => {
      native.on("message", handler);
    },
    onDisconnect: (handler) => {
      native.on("close", handler);
    },
    close: () => native.close(),
  };
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function setup<T extends object>(
  service: T,
  transfer = false,
  native = true,
  name = "transfer-test",
  afterPost?: (message: unknown) => void,
) {
  const host = new Nexus<DefaultAdapterModel>();
  const client = new Nexus<DefaultAdapterModel>();
  const token = new Token<T>(name);
  let accept!: (port: IPort, meta: object) => void;
  const capabilities = { arrayBufferTransfer: native };
  host.configure({
    endpoint: {
      meta: { context: "host" },
      implementation: {
        capabilities,
        listen: (fn) => {
          accept = fn;
        },
      },
    },
  });
  host.provide(token, service, { transfer });
  await host.ready();
  client.configure({
    endpoint: {
      meta: { context: "client" },
      implementation: {
        capabilities,
        listen() {},
        connect: async () => {
          const channel = new MessageChannel();
          closers.push(() => {
            channel.port1.close();
            channel.port2.close();
          });
          accept(port(channel.port2), {});
          return { port: port(channel.port1, afterPost), connectionMeta: {} };
        },
      },
    },
  });
  const connection = await client.connect({ target: { context: "host" } });
  closers.push(() => connection.disconnect());
  return { host, client, connection, token };
}

describe("native RPC transfer", () => {
  it("ends only the affected scope after uncertain native submission", async () => {
    const { connection, token } = await setup(
      { echo: (value: unknown) => value },
      false,
      true,
      "uncertain",
      (message) => {
        if (
          typeof message === "object" &&
          message &&
          "nexusAttachments" in message
        )
          throw new Error("unknown delivery after native submission");
      },
    );
    const scope = connection.createScope(token);
    const sibling = connection.createScope(token);
    const source = new ArrayBuffer(4);
    const result = await Nexus.safeCall(
      connection.get(token, { scope, transfer: true }).echo(source),
    );
    expect(result.isErr()).toBe(true);
    expect(scope.closed).toBe(true);
    expect(sibling.closed).toBe(false);
    expect(source.byteLength).toBe(0);
    expect(connection.status).toBe("connected");
    expect(await connection.get(token, { scope: sibling }).echo(9)).toBe(9);
  });

  it("validates one boolean policy across handles, descriptors, and decorators", async () => {
    const { host, connection, token } = await setup({
      echo: (value: number) => value,
    });
    expect(
      connection.safeGet(token, { transfer: "yes" } as never),
    ).toMatchObject({ error: { code: "E_USAGE_INVALID" } });
    expect(
      host
        .safeProvide(token, { echo: (value: number) => value }, {
          transfer: 1,
        } as never)
        .isErr(),
    ).toBe(true);
    expect(
      host
        .safeProvide({
          token,
          service: { echo: (value: number) => value },
          transfer: "yes",
        } as never)
        .isErr(),
    ).toBe(true);
    const owner = new Nexus();
    expect(() => owner.Expose(token, { transfer: "yes" } as never)).toThrow();
  });
  it("relays native attachments into a copy-only hop, including callbacks and returned refs", async () => {
    let resource!: RefWrapper<{ echo(value: ArrayBuffer): ArrayBuffer }>;
    const destination = await setup(
      {
        async echo(
          value: ArrayBuffer,
          callback: (value: ArrayBuffer) => Promise<ArrayBuffer>,
        ) {
          return callback(value);
        },
        open: () => resource,
      },
      false,
      false,
    );
    resource = destination.host.ref({ echo: (value: ArrayBuffer) => value });
    const bridge = await setup(
      { ping: () => true },
      false,
      true,
      "bridge-bootstrap",
    );
    const relay = bridge.host.relay({
      services: [destination.token],
      to: { nexus: destination.client, target: { context: "host" } },
    });
    closers.push(() => relay.dispose());
    await vi.waitFor(() =>
      expect(bridge.connection.safeGet(destination.token).isOk()).toBe(true),
    );
    const service = bridge.connection.get(destination.token, {
      transfer: true,
    });
    const input = new Uint8Array([1, 9]).buffer;
    let callbackResult!: ArrayBuffer;
    const result = await service.echo(input, async (value) => {
      callbackResult = value;
      return value;
    });
    expect([...new Uint8Array(result)]).toEqual([1, 9]);
    expect(input.byteLength).toBe(0);
    expect(callbackResult.byteLength).toBe(0);
    const remote = await service.open();
    const next = new Uint8Array([2, 8]).buffer;
    expect([...new Uint8Array(await remote.echo(next))]).toEqual([2, 8]);
    expect(next.byteLength).toBe(0);
    remote[Symbol.dispose]();
  });

  it("does not detach after timeout interrupts asynchronous payload preparation", async () => {
    const { connection, token } = await setup({
      echo: (value: unknown) => value,
    });
    let finish!: (value: ArrayBuffer) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blob = new Blob(["a"]);
    const pending = new Promise<ArrayBuffer>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(blob, "arrayBuffer").mockImplementation(() => {
      started();
      return pending;
    });
    const source = new ArrayBuffer(4);
    const call = Nexus.safeCall(
      connection
        .get(token, { transfer: true, callTimeout: 30 })
        .echo({ source, blob }),
    );
    await began;
    expect(await call).toMatchObject({ error: { code: "E_CALL_TIMEOUT" } });
    finish(new ArrayBuffer(1));
    await connection.get(token).echo("barrier");
    expect(source.byteLength).toBe(4);
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "uses independent client=%s and provider=%s policies, including callbacks",
    async (clientTransfer, providerTransfer) => {
      let received!: ArrayBuffer;
      const callbackInput = new Uint8Array([3]).buffer;
      const callbackResult = new Uint8Array([4]).buffer;
      const input = new Uint8Array([1, 2]).buffer;
      const { connection, token } = await setup(
        {
          async echo(
            value: ArrayBuffer,
            callback: (value: ArrayBuffer) => Promise<ArrayBuffer>,
          ) {
            received = value;
            expect([...new Uint8Array(await callback(callbackInput))]).toEqual([
              4,
            ]);
            return value;
          },
        },
        providerTransfer,
      );
      const service = connection.get(token, { transfer: clientTransfer });
      const operation = service.echo(input, async (value) => {
        expect([...new Uint8Array(value)]).toEqual([3]);
        return callbackResult;
      });
      expect(input.byteLength).toBe(2);
      expect([...new Uint8Array(await operation)]).toEqual([1, 2]);
      expect(input.byteLength).toBe(clientTransfer ? 0 : 2);
      expect(received.byteLength).toBe(providerTransfer ? 0 : 2);
      expect(callbackInput.byteLength).toBe(providerTransfer ? 0 : 1);
      expect(callbackResult.byteLength).toBe(clientTransfer ? 0 : 1);
      expect(await operation).toBe(await operation);
    },
  );

  it("stops at refs and captures resource policies across provider replacement", async () => {
    const cached = new Uint8Array([7]).buffer;
    let ref!: RefWrapper<{
      read(): ArrayBuffer;
      accept(value: ArrayBuffer): number;
    }>;
    const { host, connection, token } = await setup({ open: () => ref }, true);
    ref = host.ref({
      read: () => cached,
      accept: (value: ArrayBuffer) => value.byteLength,
    });
    const copyHandle = await connection.get(token).open();
    const transferHandle = await connection
      .get(token, { transfer: true })
      .open();
    expect(cached.byteLength).toBe(1);
    host.provide(token, { open: () => ref }, { transfer: false });
    const copy = new ArrayBuffer(3);
    const moved = new ArrayBuffer(3);
    await copyHandle.accept(copy);
    await transferHandle.accept(moved);
    expect(copy.byteLength).toBe(3);
    expect(moved.byteLength).toBe(0);
    expect([...new Uint8Array(await transferHandle.read())]).toEqual([7]);
    expect(cached.byteLength).toBe(0);
  });

  it("rejects unavailable transfer before executing requests and keeps the connection usable", async () => {
    const echo = vi.fn((value: unknown) => value);
    const { connection, token } = await setup({ echo }, false, false);
    const value = new ArrayBuffer(8);
    await expect(
      connection.get(token, { transfer: true }).echo(value),
    ).rejects.toMatchObject({ code: "E_PROTOCOL_ERROR" });
    expect(echo).not.toHaveBeenCalled();
    expect(value.byteLength).toBe(8);
    expect(await connection.get(token, { transfer: true }).echo(42)).toBe(42);
  });

  it("reports result transfer failure after execution without detaching the result", async () => {
    const value = new ArrayBuffer(8);
    const read = vi.fn(() => value);
    const { connection, token } = await setup({ read }, true, false);
    await expect(connection.get(token).read()).rejects.toMatchObject({
      code: "E_PROTOCOL_ERROR",
    });
    expect(read).toHaveBeenCalledOnce();
    expect(value.byteLength).toBe(8);
    expect(connection.status).toBe("connected");
  });

  it("deduplicates attachments and rejects unsupported views, detached and oversized buffers", async () => {
    const { connection, token } = await setup({
      echo: (value: unknown) => value,
    });
    const service = connection.get(token, { transfer: true });
    const buffer = new Uint8Array([8, 9]).buffer;
    const result: any = await service.echo({
      buffer,
      view: new Uint8Array(buffer),
      map: new Map([["bytes", buffer]]),
    });
    expect([...new Uint8Array(result.buffer)]).toEqual([8, 9]);
    expect([...result.view]).toEqual([8, 9]);
    expect(buffer.byteLength).toBe(0);
    await expect(service.echo(buffer)).rejects.toMatchObject({
      code: "E_PROTOCOL_ERROR",
    });
    const backing = new Uint8Array(8);
    await expect(service.echo(backing.subarray(1))).rejects.toMatchObject({
      code: "E_PROTOCOL_ERROR",
    });
    expect(backing.byteLength).toBe(8);
    const pooled = Buffer.from([1, 2]);
    await expect(service.echo(pooled)).rejects.toMatchObject({
      code: "E_PROTOCOL_ERROR",
    });
    expect([...pooled]).toEqual([1, 2]);
    const shared = new SharedArrayBuffer(4);
    await expect(service.echo(shared)).rejects.toMatchObject({
      code: "E_PROTOCOL_ERROR",
    });
    const repeated = new ArrayBuffer(8);
    const concurrent = await Promise.allSettled([
      service.echo(repeated),
      service.echo(repeated),
    ]);
    expect(
      concurrent.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    const oversized = new ArrayBuffer(64 * 1024);
    await expect(service.echo(oversized)).rejects.toMatchObject({
      code: "E_PROTOCOL_ERROR",
    });
    expect(oversized.byteLength).toBe(64 * 1024);
    const empty = new ArrayBuffer(0);
    await service.echo(empty);
    expect(() => new Uint8Array(empty)).toThrow();
  });
});

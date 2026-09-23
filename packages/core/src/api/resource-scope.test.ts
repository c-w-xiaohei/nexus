import { describe, expect, it } from "vitest";
import { Nexus } from "./nexus";
import { Token } from "./token";
import { createMockPortPair } from "../utils/test-utils";
import type { IPort } from "../transport/types/port";
import type { DefaultAdapterModel } from "../types/adapter-model";
import { SERVICE_INVOKE_START, type ServiceInvocationContext } from "../index";

describe("resource scopes", () => {
  it("releases one resource region without closing its shared connection", async () => {
    const host = new Nexus<DefaultAdapterModel>();
    const client = new Nexus<DefaultAdapterModel>();
    let accept!: (port: IPort, meta: object) => void;
    const token = new Token<{
      open(): import("../types/ref-wrapper").RefWrapper<{ read(): number }>;
      accept(value: unknown): void;
    }>("scoped");
    host.configure({
      endpoint: {
        meta: { context: "host" },
        implementation: {
          listen: (fn) => {
            accept = fn;
          },
        },
      },
    });
    let invocation: ServiceInvocationContext | undefined;
    host.provide(token, {
      [SERVICE_INVOKE_START](context: ServiceInvocationContext) {
        invocation = context;
        return context;
      },
      open: () => host.ref({ read: () => 42 }),
      accept: () => {},
    });
    await host.ready();
    client.configure({
      endpoint: {
        meta: { context: "client" },
        implementation: {
          connect: async () => {
            const [local, remote] = createMockPortPair();
            accept(remote, {});
            return { port: local, connectionMeta: {} };
          },
          listen: () => {},
        },
      },
    });
    const connection = await client.connect({ target: { context: "host" } });
    try {
      expect(typeof connection.createScope).toBe("function");
      const first = connection.createScope(token);
      const second = connection.createScope(token);
      const a = await connection.get(token, { scope: first }).open();
      const b = await connection.get(token, { scope: second }).open();
      expect(await a.read()).toBe(42);
      // A remote capability cannot be silently re-exported into another region.
      await expect(
        connection.get(token, { scope: second }).accept(a),
      ).rejects.toMatchObject({ code: "E_PROTOCOL_ERROR" });
      first.close();
      await expect(a.read()).rejects.toMatchObject({
        code: "E_RESOURCE_SCOPE_CLOSED",
      });
      a[Symbol.dispose]();
      await expect(a.read()).rejects.toMatchObject({
        code: "E_RESOURCE_SCOPE_CLOSED",
      });
      expect(await b.read()).toBe(42);
      expect(connection.status).toBe("connected");
      const ended: string[] = [];
      first.onClosed(() => ended.push("closed"));
      first.close();
      expect(ended).toEqual(["closed"]);
      expect(
        connection.safeGet(new Token("other"), { scope: second }).isErr(),
      ).toBe(true);
      second.close();
      const third = connection.createScope(token);
      await connection.get(token, { scope: third }).open();
      const serverScope = invocation?.scope;
      expect(serverScope?.serviceId).toBe(token.id);
      const closedByService = new Promise<void>((resolve) =>
        third.onClosed(resolve),
      );
      serverScope?.close();
      await closedByService;
      expect(connection.status).toBe("connected");
    } finally {
      connection.disconnect();
    }
  });
});

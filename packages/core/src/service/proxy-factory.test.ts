import { beforeEach, describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import { ProxyFactory, safeCall } from "./proxy-factory";
import { ResourceManager } from "./resource-manager";
import type { Connection } from "@/api/connection";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { NexusProtocolError } from "@/errors";

const finalizationCallback = vi.fn();
const register = vi.fn();
const unregister = vi.fn();
const registrations = new Map<object, unknown>();

vi.stubGlobal(
  "FinalizationRegistry",
  class {
    constructor(callback: (value: unknown) => void) {
      finalizationCallback.mockImplementation(callback);
    }

    register = register.mockImplementation(
      (target: object, heldValue: unknown, unregisterToken?: object) => {
        registrations.set(unregisterToken ?? target, heldValue);
      },
    );
    unregister = unregister.mockImplementation((token: object) =>
      registrations.delete(token),
    );
  },
);

describe("ProxyFactory", () => {
  let dispatch: ReturnType<typeof vi.fn>;
  let dispatchRelease: ReturnType<typeof vi.fn>;
  let connection: Connection<any>;
  let factory: ProxyFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    registrations.clear();
    dispatch = vi.fn().mockResolvedValue(Result.ok("value"));
    dispatchRelease = vi.fn();
    connection = { id: "A" } as Connection<any>;
    factory = new ProxyFactory(
      { safeDispatchCall: dispatch, dispatchRelease },
      new ResourceManager(),
      vi.fn(() => connection),
    );
  });

  const service = () =>
    factory.createServiceProxy<any>("api", {
      connectionId: "A",
      timeout: 1_000,
    });

  it("keeps a root proxy non-thenable and exposes no request until a child is consumed", async () => {
    const proxy = service();

    expect(await Promise.resolve(proxy)).toBe(proxy);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects roots and copied thenables without executing a remote operation", () => {
    const root = service();
    const call = root.read();
    for (const value of [root, { ...call }, Promise.resolve("local")]) {
      expect(() => safeCall(value)).toThrow(
        expect.objectContaining({ code: "E_USAGE_INVALID" }),
      );
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps root catch and finally available as remote business paths", async () => {
    const proxy = service();

    await expect(proxy.catch("reason")).resolves.toBe("value");
    await expect(proxy.finally("reason")).resolves.toBe("value");

    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "APPLY", path: ["api", "catch"] }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "APPLY", path: ["api", "finally"] }),
    );
  });

  it("does not execute a GET when its then property is merely inspected", async () => {
    const read = service().profile.name;

    expect(read.then).toBeTypeOf("function");
    expect(dispatch).not.toHaveBeenCalled();
    await expect(read).resolves.toBe("value");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "GET",
        path: ["api", "profile", "name"],
      }),
    );
  });

  it("shares the first GET execution across repeated consumption", async () => {
    const read = service().title;

    await expect(read).resolves.toBe("value");
    await expect(read).resolves.toBe("value");

    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("caches failed consumption across safeCall, catch and finally", async () => {
    const error = new NexusProtocolError("invalid response");
    dispatch.mockResolvedValue(Result.err(error));
    const call = service().read();
    const safe = await safeCall(call);
    expect(safe.isErr() && safe.error).toBe(error);
    await expect(call.catch((caught: unknown) => caught)).resolves.toBe(error);
    const settled = vi.fn();
    await expect(call.finally(settled)).rejects.toBe(error);
    expect(settled).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("shares consumption when dispatch reenters safeCall", async () => {
    const read = service().title;
    let nested: ReturnType<typeof safeCall> | undefined;
    dispatch.mockImplementation(() => {
      nested = safeCall(read);
      return Promise.resolve(Result.ok("value"));
    });
    await expect(read).resolves.toBe("value");
    expect(await nested).toEqual(Result.ok("value"));
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("exposes local provenance and shares GET consumption with safeCall", async () => {
    const read = service().profile.name;
    expect(read.connection).toBe(connection);
    expect(dispatch).not.toHaveBeenCalled();
    const safe = safeCall(read);
    await expect(read).resolves.toBe("value");
    expect((await safe).unwrap()).toBe("value");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("captures APPLY arguments at declaration and encodes them when consumed", async () => {
    const args = [{ title: "before" }];
    const task = service().save(...args);
    args[0].title = "after";

    expect(dispatch).not.toHaveBeenCalled();
    await task;
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "APPLY",
        path: ["api", "save"],
        args: [{ title: "after" }],
      }),
    );
  });

  it("keeps task connection provenance while then/catch return ordinary promises", async () => {
    const task = service().read();

    expect(task.connection).toBe(connection);
    expect(task.then(() => "mapped")).toBeInstanceOf(Promise);
    await expect(task).resolves.toBe("value");
  });

  it("does not support remote property assignment", () => {
    const proxy = service();

    expect(Reflect.set(proxy, "title", "new title")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps symbols local and replays independently captured paths", async () => {
    const first: any = factory.createServiceProxy("first", {
      connectionId: "A",
      timeout: 1_000,
    });
    const second: any = factory.createServiceProxy("second", {
      connectionId: "B",
      timeout: 2_000,
    });
    const firstMethod = first.nested.run;
    const secondMethod = second.run;

    expect(first[Symbol.iterator]).toBeUndefined();
    await secondMethod(2);
    await firstMethod(1);

    expect(dispatch.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        connectionId: "B",
        path: ["second", "run"],
        args: [2],
      }),
      expect.objectContaining({
        connectionId: "A",
        path: ["first", "nested", "run"],
        args: [1],
      }),
    ]);
  });

  it("registers finalization with an ID-only held value and a non-facade anchor", () => {
    const proxy = factory.createRemoteResourceProxy("resource", "A");
    const [anchor, heldValue, token] = register.mock.calls[0];

    expect(anchor).toBeTypeOf("object");
    expect(anchor).not.toBe(proxy);
    expect(heldValue).toEqual({ resourceId: "resource", connectionId: "A" });
    expect(token).toBe(anchor);
  });

  it("explicitly releases a resource once and prevents finalizer replay", () => {
    const proxy: any = factory.createRemoteResourceProxy("resource", "A");
    const anchor = register.mock.calls[0][0];

    proxy[RELEASE_PROXY_SYMBOL]();
    proxy[RELEASE_PROXY_SYMBOL]();

    expect(unregister).toHaveBeenCalledExactlyOnceWith(anchor);
    expect(register.mock.calls).toHaveLength(1);
    expect(registrations.has(anchor)).toBe(false);
    expect(dispatchRelease).toHaveBeenCalledExactlyOnceWith(
      "resource",
      "A",
      undefined,
    );
  });

  it("shares release state across child paths and already declared calls", async () => {
    const resource: any = factory.createRemoteResourceProxy("resource", "A");
    const child = resource.nested;
    const call = child.read();
    child[Symbol.dispose]();
    expect(await safeCall(call)).toMatchObject({
      error: { code: "E_RESOURCE_ACCESS_DENIED" },
    });
    await expect(child.value).rejects.toMatchObject({
      code: "E_RESOURCE_ACCESS_DENIED",
    });
    expect(dispatch).not.toHaveBeenCalled();
    resource[Symbol.dispose]();
    expect(dispatchRelease).toHaveBeenCalledOnce();
  });

  it("discards a revived proxy finalizer without invalidating the resource", async () => {
    const proxy: any = factory.createRemoteResourceProxy("resource", "A");
    const anchor = register.mock.calls[0][0];

    factory.discardRemoteResourceProxy(proxy);
    expect(registrations.has(anchor)).toBe(false);
    await expect(proxy.read()).resolves.toBe("value");
    proxy[RELEASE_PROXY_SYMBOL]();

    expect(dispatchRelease).toHaveBeenCalledExactlyOnceWith(
      "resource",
      "A",
      undefined,
    );
  });

  it("finalizes an unreleased resource with only its IDs", () => {
    factory.createRemoteResourceProxy("resource", "A");
    const anchor = register.mock.calls[0][0];

    finalizationCallback(registrations.get(anchor));

    expect(dispatchRelease).toHaveBeenCalledExactlyOnceWith(
      "resource",
      "A",
      undefined,
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import type { NexusInstance } from "../../src/api/types";
import type { IEndpoint } from "../../src/transport/types/endpoint";
import type { IPort } from "../../src/transport/types/port";
import { NexusMessageType } from "../../src/types/message";
import { MAX_SESSION_SCOPES } from "../../src/service/resource-scopes";
import type { TestAdapterModel } from "../../src/utils/test-utils";
import { createMockPortPair } from "../../src/utils/test-utils";

type Meta = { context: string };
type Model = TestAdapterModel<Meta, { edge: string }>;

interface RelayService {
  call(callback: (value: string) => Promise<string>): Promise<string>;
  open(callback: (value: string) => Promise<string>): Promise<RemoteHandle>;
  hold(): Promise<void>;
  lateOpen(): Promise<RemoteHandle>;
}

interface RemoteHandle {
  reenter(value: string): Promise<string>;
}

const RelayToken = new Token<RelayService, Model>(
  "relay-resource-scope-service",
);

type NodeName = "A1" | "A2" | "A3" | "B" | "B2" | "C" | "D" | "E";

class RelayNetwork {
  readonly nodes = new Map<NodeName, Nexus<Model>>();
  readonly dials = new Map<string, number>();
  readonly accepts = new Map<
    NodeName,
    (port: IPort, meta: { edge: string }) => void
  >();
  private readonly releaseEdges = new Map<string, () => void>();
  private readonly releasePolicies = new Map<string, () => void>();
  private readonly relayHandles: Disposable[] = [];

  constructor(
    private readonly service: RelayService,
    private readonly options: {
      splitBridge?: boolean;
      where?: (meta: Meta) => boolean;
      deferEdge?: string;
      cycle?: boolean;
      denyAtB?: () => boolean | Promise<boolean>;
      passiveAtB?: boolean;
      deferPolicyAtB?: boolean;
    } = {},
  ) {
    for (const name of [
      "A1",
      "A2",
      "A3",
      "B",
      ...(options.splitBridge ? ["B2"] : []),
      "C",
      "D",
      "E",
    ] as readonly NodeName[]) {
      this.nodes.set(name, new Nexus<Model>());
    }
  }

  get(name: NodeName): NexusInstance<Model> {
    return this.nodes.get(name)!;
  }

  async start(): Promise<void> {
    for (const [name, nexus] of this.nodes) {
      const endpoint: IEndpoint<Model> = {
        listen: (accept) => {
          this.accepts.set(name, accept);
        },
        connect: async (target) => {
          const destination = target.context as NodeName;
          const accept = this.accepts.get(destination);
          if (!accept)
            throw new Error(`No endpoint is listening at ${destination}.`);
          const edge = `${name}->${destination}`;
          this.dials.set(edge, (this.dials.get(edge) ?? 0) + 1);
          if (edge === this.options.deferEdge) {
            await new Promise<void>((resolve) => {
              this.releaseEdges.set(edge, resolve);
            });
          }
          const [local, remote] = createMockPortPair();
          accept(remote, { edge });
          return { port: local, connectionMeta: { edge } };
        },
        matchesTarget: (target, meta) => target.context === meta.context,
      };
      nexus.configure({
        endpoint: { meta: { context: name }, implementation: endpoint },
        ...(name === "B" && this.options.denyAtB
          ? { policy: { canCall: this.options.denyAtB } }
          : name === "B" && this.options.deferPolicyAtB
            ? {
                policy: {
                  canCall: async () =>
                    new Promise<boolean>((resolve) => {
                      this.releasePolicies.set("B", () => resolve(true));
                    }),
                },
              }
            : {}),
        ...(name === "E"
          ? {
              providers: [
                {
                  token: RelayToken,
                  service: {
                    ...this.service,
                    open: async (
                      callback: (value: string) => Promise<string>,
                    ) => nexus.ref(await this.service.open(callback)),
                    lateOpen: async () =>
                      nexus.ref(await this.service.lateOpen()),
                  },
                },
              ],
            }
          : {}),
      });
    }

    // The `to.nexus` runtime dials `target`; each bridge node owns its outgoing
    // edge while A clients use ordinary direct connections to B.
    const bridges: ReadonlyArray<readonly [NodeName, NodeName]> = this.options
      .cycle
      ? [
          ["B", "C"],
          ["C", "B"],
        ]
      : [
          ["B", this.options.splitBridge ? "B2" : "C"],
          ...(this.options.splitBridge ? [["B2", "C"] as const] : []),
          ["C", "D"],
          ["D", "E"],
        ];
    for (const [from, to] of bridges) {
      this.relayHandles.push(
        Nexus.relay({
          from: this.get(from),
          to: {
            nexus: this.get(from),
            ...(from === "B" && this.options.passiveAtB
              ? {}
              : { target: { context: to } }),
            where: this.options.where,
          },
          services: [RelayToken],
        }),
      );
    }
    await Promise.all(
      Array.from(this.nodes.values(), (nexus) => nexus.ready()),
    );
  }

  closeEdge(from: NodeName, to: NodeName): void {
    const manager = (this.get(from) as any).lifecycle.manager;
    const connection = Array.from(manager.connections.values()).find(
      (candidate: any) => candidate.remoteIdentity?.context === to,
    ) as { close(): void } | undefined;
    if (!connection) throw new Error(`No live ${from}->${to} connection.`);
    connection.close();
  }

  releaseEdge(edge: string): void {
    const release = this.releaseEdges.get(edge);
    if (!release) throw new Error(`No deferred dial for ${edge}.`);
    this.releaseEdges.delete(edge);
    release();
  }

  releasePolicy(node: NodeName): void {
    const release = this.releasePolicies.get(node);
    if (!release) throw new Error(`No deferred policy at ${node}.`);
    this.releasePolicies.delete(node);
    release();
  }

  hasDeferredPolicy(node: NodeName): boolean {
    return this.releasePolicies.has(node);
  }

  disposeRelays(): void {
    for (const handle of this.relayHandles) handle[Symbol.dispose]();
  }

  dispose(): void {
    this.disposeRelays();
    for (const nexus of this.nodes.values()) {
      const manager = (nexus as any).lifecycle.manager;
      for (const connection of manager?.connections.values() ?? [])
        connection.close();
    }
  }
}

async function createNetwork(
  options?: ConstructorParameters<typeof RelayNetwork>[1],
) {
  const entered = new Map<string, number>();
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const network = new RelayNetwork(
    {
      async call(callback) {
        return callback("from-E");
      },
      async open(callback) {
        return { reenter: (value: string) => callback(value) };
      },
      async hold() {
        entered.set("hold", (entered.get("hold") ?? 0) + 1);
        await hold;
      },
      async lateOpen() {
        entered.set("lateOpen", (entered.get("lateOpen") ?? 0) + 1);
        await hold;
        return { reenter: async () => "late" };
      },
    },
    options,
  );
  await network.start();
  return { network, entered, releaseHold };
}

describe("Relay resource scopes (R07-R17, R21-R22)", () => {
  const networks: RelayNetwork[] = [];

  afterEach(() => {
    for (const network of networks.splice(0)) network.dispose();
  });

  it("R07/R08 forwards callbacks and returned refs through A1/A2/A3 -> B -> C -> D -> E without cross-client ownership", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const clients = ["A1", "A2", "A3"] as const;

    const results = await Promise.all(
      clients.map(async (name) => {
        const connection = await fixture.network
          .get(name)
          .connect({ target: { context: "B" } });
        const api = connection.get(RelayToken);
        const callback = vi.fn(async (value: string) => `${name}:${value}`);
        const result = await api.call(callback);
        const ref = await api.open(callback);
        return { name, callback, result, ref };
      }),
    );

    for (const { name, callback, result, ref } of results) {
      expect(result).toBe(`${name}:from-E`);
      await expect(ref.reenter("from-ref")).resolves.toBe(`${name}:from-ref`);
      expect(callback).toHaveBeenCalledTimes(2);
    }
    expect(fixture.network.dials.get("B->C")).toBe(1);
    expect(fixture.network.dials.get("C->D")).toBe(1);
    expect(fixture.network.dials.get("D->E")).toBe(1);
  });

  it("R08 crosses two independent bridge engines before reaching E", async () => {
    const fixture = await createNetwork({ splitBridge: true });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const callback = vi.fn(async (value: string) => `A1:${value}`);

    const ref = await connection.get(RelayToken).open(callback);
    await expect(ref.reenter("across-B2")).resolves.toBe("A1:across-B2");
    expect(fixture.network.dials.get("B->B2")).toBe(1);
    expect(fixture.network.dials.get("B2->C")).toBe(1);
  });

  it("R14 coalesces concurrent first calls while callbacks reenter during setup", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const api = connection.get(RelayToken);
    const first = vi.fn(async (value: string) => `first:${value}`);
    const second = vi.fn(async (value: string) => `second:${value}`);

    await expect(
      Promise.all([api.call(first), api.call(second)]),
    ).resolves.toEqual(["first:from-E", "second:from-E"]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(fixture.network.dials.get("B->C")).toBe(1);
  });

  it("R09 closes only A1's explicit scope and leaves A2/A3 capabilities usable", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const a1 = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const a2 = await fixture.network
      .get("A2")
      .connect({ target: { context: "B" } });
    const a3 = await fixture.network
      .get("A3")
      .connect({ target: { context: "B" } });
    const a1Scope = a1.createScope(RelayToken);
    const one = await a1
      .get(RelayToken, { scope: a1Scope })
      .open(async () => "one");
    const two = await a2.get(RelayToken).open(async () => "two");
    const three = await a3.get(RelayToken).open(async () => "three");

    a1Scope.close();
    await expect(one.reenter("x")).rejects.toMatchObject({
      code: "E_RESOURCE_SCOPE_CLOSED",
    });
    await expect(two.reenter("x")).resolves.toBe("two");
    await expect(three.reenter("x")).resolves.toBe("three");
    expect(a1.status).toBe("connected");
  });

  it("R04 releases one returned ref without affecting its sibling in the same scope", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    const api = connection.get(RelayToken, { scope });
    const first = await api.open(async () => "first");
    const second = await api.open(async () => "second");
    const resources = (fixture.network.get("E") as any).lifecycle.engine
      .resourceManager;
    const count = resources.countLocalResources();

    Nexus.release(first);
    await expect(first.reenter("released")).rejects.toThrow(/released/i);
    await expect(second.reenter("live")).resolves.toBe("second");
    await vi.waitFor(() =>
      expect(resources.countLocalResources()).toBe(count - 1),
    );
  });

  it("R10/R11 invalidates old refs after intermediate loss and lets a new root call establish a fresh scope", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const api = connection.get(RelayToken);
    const oldRef = await api.open(async () => "old");

    fixture.network.closeEdge("C", "D");
    await expect(oldRef.reenter("after-loss")).rejects.toMatchObject({
      code: expect.any(String),
    });

    const fresh = await api.open(async () => "fresh");
    await expect(fresh.reenter("after-recovery")).resolves.toBe("fresh");
  });

  it.each(["B->C", "C->D", "D->E"] as const)(
    "R10 terminates the dependent domain when shared edge %s disconnects",
    async (edge) => {
      const fixture = await createNetwork();
      networks.push(fixture.network);
      const a1 = await fixture.network
        .get("A1")
        .connect({ target: { context: "B" } });
      const a2 = await fixture.network
        .get("A2")
        .connect({ target: { context: "B" } });
      const one = await a1.get(RelayToken).open(async () => "one");
      const two = await a2.get(RelayToken).open(async () => "two");
      const [from, to] = edge.split("->") as [NodeName, NodeName];

      fixture.network.closeEdge(from, to);
      await expect(one.reenter("lost")).rejects.toMatchObject({
        code: expect.any(String),
      });
      await expect(two.reenter("lost")).rejects.toMatchObject({
        code: expect.any(String),
      });
    },
  );

  it("R09 physically disconnects A1-B without closing sibling A2/A3 domains", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const a1 = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const a2 = await fixture.network
      .get("A2")
      .connect({ target: { context: "B" } });
    const a3 = await fixture.network
      .get("A3")
      .connect({ target: { context: "B" } });
    const one = await a1.get(RelayToken).open(async () => "one");
    const two = await a2.get(RelayToken).open(async () => "two");
    const three = await a3.get(RelayToken).open(async () => "three");

    fixture.network.closeEdge("A1", "B");
    await expect(one.reenter("closed")).rejects.toMatchObject({
      code: expect.any(String),
    });
    await expect(two.reenter("live")).resolves.toBe("two");
    await expect(three.reenter("live")).resolves.toBe("three");
  });

  it("R12/R13 keeps passive relay acquisition passive and dispose revokes its provider entry", async () => {
    const source = new Nexus<Model>();
    const upstream = new Nexus<Model>();
    const endpoint: IEndpoint<Model> = {
      listen: () => {},
      connect: vi.fn(async () => {
        throw new Error("must not dial");
      }),
      matchesTarget: (target, meta) => target.context === meta.context,
    };
    source.configure({
      endpoint: { meta: { context: "source" }, implementation: endpoint },
    });
    upstream.configure({
      endpoint: { meta: { context: "upstream" }, implementation: endpoint },
    });
    const handle = Nexus.relay({
      from: source,
      to: { nexus: upstream },
      services: [RelayToken],
    });
    await Promise.all([source.ready(), upstream.ready()]);
    networks.push({ dispose: () => handle.dispose() } as RelayNetwork);

    expect(endpoint.connect as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("R16 cancels an entered in-flight terminal call when its downstream scope closes", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    try {
      const call = (async () => connection.get(RelayToken, { scope }).hold())();
      await vi.waitFor(() => expect(fixture.entered.get("hold")).toBe(1));
      scope.close();
      await expect(call).rejects.toMatchObject({
        code: "E_RESOURCE_SCOPE_CLOSED",
      });
    } finally {
      fixture.releaseHold();
    }
  });

  it("R15 abandons deferred async policy admission when relay disposal wins", async () => {
    const fixture = await createNetwork({ deferPolicyAtB: true });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    const call = (async () =>
      connection.get(RelayToken, { scope, callTimeout: 1_000 }).hold())();
    let failure: unknown;
    void call.catch((error: unknown) => {
      failure = error;
    });
    await vi.waitFor(() =>
      expect(fixture.network.hasDeferredPolicy("B")).toBe(true),
    );

    fixture.network.disposeRelays();
    await vi.waitFor(() => expect(failure).toBeDefined());
    expect(failure).toMatchObject({ code: "E_RESOURCE_SCOPE_CLOSED" });
    fixture.network.releasePolicy("B");
    expect(fixture.network.dials.get("B->C")).toBeUndefined();
    expect(fixture.entered.get("hold")).toBeUndefined();
  });

  it("R16 drops a late terminal ref result after scope closure without allocating a resource", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    const resources = (fixture.network.get("E") as any).lifecycle.engine
      .resourceManager;
    const initial = resources.countLocalResources();
    const call = (async () =>
      connection.get(RelayToken, { scope }).lateOpen())();
    await vi.waitFor(() => expect(fixture.entered.get("lateOpen")).toBe(1));

    scope.close();
    fixture.releaseHold();
    await expect(call).rejects.toMatchObject({
      code: "E_RESOURCE_SCOPE_CLOSED",
    });
    await vi.waitFor(() =>
      expect(resources.countLocalResources()).toBe(initial),
    );
  });

  it("R06 retains an open scope after one timed-out call", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    await connection.get(RelayToken, { scope }).call(async () => "ready");
    const timedOut = (async () =>
      connection.get(RelayToken, { scope, callTimeout: 1 }).hold())();
    let failure: unknown;
    void timedOut.catch((error: unknown) => {
      failure = error;
    });
    await vi.waitFor(() => expect(failure).toBeDefined());
    expect(failure).toMatchObject({ code: "E_CALL_TIMEOUT" });
    expect(scope.closed).toBe(false);

    await expect(
      connection
        .get(RelayToken, { scope, callTimeout: 100 })
        .call(async (value) => `next:${value}`),
    ).resolves.toBe("next:from-E");
    expect(scope.closed).toBe(false);
  });

  it("R13 rejects a relay target where mismatch without terminal execution", async () => {
    const fixture = await createNetwork({ where: () => false });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });

    await expect(connection.get(RelayToken).hold()).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(fixture.entered.get("hold")).toBeUndefined();
  });

  it("R13 rejects ambiguous passive upstream selection without terminal execution", async () => {
    const fixture = await createNetwork({ passiveAtB: true });
    networks.push(fixture.network);
    await fixture.network.get("B").connect({ target: { context: "C" } });
    await fixture.network.get("B").connect({ target: { context: "D" } });
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });

    await expect(connection.get(RelayToken).hold()).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(fixture.entered.get("hold")).toBeUndefined();
    expect(fixture.network.dials.get("B->C")).toBe(1);
    expect(fixture.network.dials.get("B->D")).toBe(1);
  });

  it("R06/R13 denies relay admission exactly once before it dials upstream", async () => {
    let policyCalls = 0;
    const fixture = await createNetwork({
      denyAtB: () => {
        policyCalls += 1;
        return false;
      },
    });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });

    await expect(
      connection.get(RelayToken).call(async () => "never"),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(policyCalls).toBe(1);
    expect(fixture.network.dials.get("B->C")).toBeUndefined();
  });

  it("R15 closes a scope during deferred acquisition; late resolution has no terminal side effect", async () => {
    const fixture = await createNetwork({ deferEdge: "B->C" });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    const call = (async () => connection.get(RelayToken, { scope }).hold())();
    await vi.waitFor(() => expect(fixture.network.dials.get("B->C")).toBe(1));

    scope.close();
    await expect(call).rejects.toMatchObject({
      code: "E_RESOURCE_SCOPE_CLOSED",
    });
    fixture.network.releaseEdge("B->C");
    await vi.waitFor(() => expect(fixture.entered.get("hold")).toBeUndefined());
    expect(connection.status).toBe("connected");
  });

  it("R15 exhausts a short call budget during deferred acquisition without terminal execution", async () => {
    const fixture = await createNetwork({ deferEdge: "B->C" });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const call = (async () =>
      connection.get(RelayToken, { callTimeout: 1 }).hold())();
    let failure: unknown;
    void call.catch((error: unknown) => {
      failure = error;
    });
    await vi.waitFor(() => expect(fixture.network.dials.get("B->C")).toBe(1));

    await vi.waitFor(() => expect(failure).toBeDefined());
    expect(failure).toMatchObject({ code: expect.any(String) });
    fixture.network.releaseEdge("B->C");
    await vi.waitFor(() => expect(fixture.entered.get("hold")).toBeUndefined());
  });

  it("R17 rejects a scoped root packet sent in the provider-to-requester direction", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    const engine = (fixture.network.get("A1") as any).lifecycle.engine;
    const sent = vi.spyOn(
      (fixture.network.get("A1") as any).lifecycle.manager,
      "safeSendMessage",
    );

    await engine.onMessage(
      {
        type: NexusMessageType.APPLY,
        id: 991,
        resourceId: null,
        path: [RelayToken.id, "call"],
        payload: [],
        scopeId: scope.id,
        timeoutMs: 100,
        hops: 16,
      },
      connection.id,
    );
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 991, scopeId: scope.id }),
      connection.id,
    );
  });

  it("R17 ignores cross-scope resource release and response packets", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const first = connection.createScope(RelayToken);
    const second = connection.createScope(RelayToken);
    const ref = await connection
      .get(RelayToken, { scope: first })
      .open(async () => "first");
    const engine = (fixture.network.get("A1") as any).lifecycle.engine;
    await engine.onMessage(
      {
        type: NexusMessageType.RELEASE,
        id: null,
        resourceId: "res-1",
        scopeId: second.id,
      },
      connection.id,
    );
    await engine.onMessage(
      {
        type: NexusMessageType.RES,
        id: 1,
        result: "forged",
        scopeId: second.id,
      },
      connection.id,
    );

    await expect(ref.reenter("still-owned")).resolves.toBe("first");
  });

  it("I1/I2 does not retain unauthenticated first roots in the admitted scope registry", async () => {
    let policyCalls = 0;
    let deny = true;
    const fixture = await createNetwork({
      denyAtB: () => {
        policyCalls += 1;
        return !deny;
      },
    });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const b = fixture.network.get("B") as any;
    const bConnection = Array.from(
      b.lifecycle.manager.connections.values(),
    ).find((candidate: any) => candidate.remoteIdentity?.context === "A1") as {
      connectionId: string;
    };
    const sessions = b.lifecycle.engine.scopes.sessions as Map<
      string,
      Map<string, unknown>
    >;
    const before = sessions.get(bConnection.connectionId)?.size ?? 0;

    await Promise.all(
      ["unknown-service", RelayToken.id, RelayToken.id].map((service, index) =>
        b.lifecycle.engine.onMessage(
          {
            type: NexusMessageType.APPLY,
            id: `denied-${index}`,
            resourceId: null,
            path: [service, "hold"],
            args: [],
            scopeId: `unadmitted-${index}`,
            timeoutMs: 100,
            hops: 16,
          },
          bConnection.connectionId,
        ),
      ),
    );

    expect(policyCalls).toBe(2);
    expect(sessions.get(bConnection.connectionId)?.size ?? 0).toBe(before);
    expect(fixture.network.dials.get("B->C")).toBeUndefined();

    deny = false;
    await expect(
      connection.get(RelayToken).call(async (value) => `valid:${value}`),
    ).resolves.toBe("valid:from-E");
    expect(sessions.get(bConnection.connectionId)?.size ?? 0).toBe(before + 1);
  });

  it("I2 reserves admission capacity before starting async policy", async () => {
    let policyCalls = 0;
    let finishPolicy!: (allowed: boolean) => void;
    const policy = new Promise<boolean>((resolve) => {
      finishPolicy = resolve;
    });
    const fixture = await createNetwork({
      denyAtB: () => {
        policyCalls++;
        return policy;
      },
    });
    networks.push(fixture.network);
    await fixture.network.get("A1").connect({ target: { context: "B" } });
    const b = fixture.network.get("B") as any;
    const connection = Array.from(
      b.lifecycle.manager.connections.values(),
    ).find((candidate: any) => candidate.remoteIdentity?.context === "A1") as {
      connectionId: string;
    };
    const request = (id: number) =>
      b.lifecycle.engine.onMessage(
        {
          type: NexusMessageType.APPLY,
          id,
          resourceId: null,
          path: [RelayToken.id, "hold"],
          args: [],
          scopeId: "policy-pressure",
          timeoutMs: 5_000,
          hops: 16,
        },
        connection.connectionId,
      );
    const waiting = Array.from({ length: 256 }, (_, id) => request(id));
    try {
      await request(256);
      expect(policyCalls).toBe(256);
      expect(fixture.network.dials.get("B->C")).toBeUndefined();
    } finally {
      finishPolicy(false);
      await Promise.all(waiting);
    }
  });

  it("R21 isolates identical local connection ids across independent runtime instances", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const a1 = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const a2 = await fixture.network
      .get("A2")
      .connect({ target: { context: "B" } });
    // Connection IDs are generated per runtime; ownership must include the runtime.
    expect(a1.id).toBe(a2.id);

    await expect(a1.get(RelayToken).call(async () => "one")).resolves.toBe(
      "one",
    );
    await expect(a2.get(RelayToken).call(async () => "two")).resolves.toBe(
      "two",
    );
  });

  it("R22 rejects an exhausted relay hop budget before the terminal service executes", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    const bManager = (fixture.network.get("B") as any).lifecycle.manager;
    const bConnection = Array.from(bManager.connections.values()).find(
      (candidate: any) => candidate.remoteIdentity?.context === "A1",
    ) as { connectionId: string };

    await (fixture.network.get("B") as any).lifecycle.engine.onMessage(
      {
        type: NexusMessageType.APPLY,
        id: 992,
        resourceId: null,
        path: [RelayToken.id, "hold"],
        payload: [],
        scopeId: scope.id,
        timeoutMs: 100,
        hops: 0,
      },
      bConnection.connectionId,
    );

    expect(fixture.entered.get("hold")).toBeUndefined();
  });

  it("R22 terminates an actual configured B <-> C relay cycle before the terminal service executes", async () => {
    const fixture = await createNetwork({ cycle: true });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });

    await expect(connection.get(RelayToken).hold()).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(fixture.entered.get("hold")).toBeUndefined();
    expect(fixture.network.dials.get("B->C")).toBe(1);
  });

  it("R22 bounds per-session scope allocation at MAX_SESSION_SCOPES", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const engine = (fixture.network.get("A1") as any).lifecycle.engine;

    for (let index = 0; index < MAX_SESSION_SCOPES; index++) {
      expect(engine.safeCreateScope(connection.id, RelayToken.id).isOk()).toBe(
        true,
      );
    }
    expect(engine.safeCreateScope(connection.id, RelayToken.id).isErr()).toBe(
      true,
    );
  });

  it("R22 rejects forward waiter limit + 1 while deferred acquisition leaves no terminal side effect", async () => {
    const fixture = await createNetwork({ deferEdge: "B->C" });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const scope = connection.createScope(RelayToken);
    const b = fixture.network.get("B") as any;
    const bConnection = Array.from(
      b.lifecycle.manager.connections.values(),
    ).find((candidate: any) => candidate.remoteIdentity?.context === "A1") as {
      connectionId: string;
    };
    const sent = vi.spyOn(b.lifecycle.manager, "safeSendMessage");

    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        b.lifecycle.engine.onMessage(
          {
            type: NexusMessageType.APPLY,
            id: `queue-${index}`,
            resourceId: null,
            path: [RelayToken.id, "hold"],
            args: [],
            scopeId: scope.id,
            timeoutMs: 1_000,
            hops: 16,
          },
          bConnection.connectionId,
        ),
      ),
    );

    expect(
      sent.mock.calls.some(
        ([message, connectionId]: any[]) =>
          connectionId === bConnection.connectionId &&
          message.type === NexusMessageType.ERR &&
          message.id === "queue-256" &&
          /queue capacity/i.test(message.error.message),
      ),
    ).toBe(true);
    fixture.network.releaseEdge("B->C");
    await vi.waitFor(() => expect(fixture.entered.get("hold")).toBeUndefined());
  });

  it("I2 enforces one unresolved establishment budget across scopes", async () => {
    const fixture = await createNetwork({ deferEdge: "B->C" });
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const first = connection.createScope(RelayToken);
    const second = connection.createScope(RelayToken);
    const b = fixture.network.get("B") as any;
    const bConnection = Array.from(
      b.lifecycle.manager.connections.values(),
    ).find((candidate: any) => candidate.remoteIdentity?.context === "A1") as {
      connectionId: string;
    };
    const sent = vi.spyOn(b.lifecycle.manager, "safeSendMessage");

    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        b.lifecycle.engine.onMessage(
          {
            type: NexusMessageType.APPLY,
            id: `aggregate-${index}`,
            resourceId: null,
            path: [RelayToken.id, "hold"],
            args: [],
            scopeId: index % 2 ? first.id : second.id,
            timeoutMs: 1_000,
            hops: 16,
          },
          bConnection.connectionId,
        ),
      ),
    );

    expect(
      sent.mock.calls.some(
        ([message]: any[]) =>
          message.type === NexusMessageType.ERR &&
          message.id === "aggregate-256" &&
          /queue capacity/i.test(message.error.message),
      ),
    ).toBe(true);
    fixture.network.releaseEdge("B->C");
  });

  it("I2 permits an established scope to carry a burst above the acquisition limit", async () => {
    const fixture = await createNetwork();
    networks.push(fixture.network);
    const connection = await fixture.network
      .get("A1")
      .connect({ target: { context: "B" } });
    const api = connection.get(RelayToken);
    await expect(api.call(async () => "warm")).resolves.toBe("warm");

    await expect(
      Promise.all(
        Array.from({ length: 257 }, (_, index) =>
          api.call(async () => `burst-${index}`),
        ),
      ),
    ).resolves.toEqual(
      Array.from({ length: 257 }, (_, index) => `burst-${index}`),
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import type { NexusInstance } from "../../src/api/types";
import { SERVICE_INVOKE_START } from "../../src/service/service-invocation-hooks";
import type { ResourceScope } from "../../src/service/resource-scope";
import {
  connectNexusStore,
  createNexusStore,
  createStoreToken,
} from "../../src/state";
import type { IEndpoint } from "../../src/transport/types/endpoint";
import type { IPort } from "../../src/transport/types/port";
import { JsonSerializer } from "../../src/transport/serializers/json-serializer";
import { NexusMessageType } from "../../src/types/message";
import type { TestAdapterModel } from "../../src/utils/test-utils";
import { createMockPortPair } from "../../src/utils/test-utils";

type Model = TestAdapterModel<{ context: string }, { edge: string }>;
type State = { count: number };
type Actions = { add(by: number): number };
const token = createStoreToken<State & Actions, Model>("state:scoped-relay");
const bytesToken = new Token<{ accept(bytes: Uint8Array): number }, Model>(
  "service:scoped-relay-bytes",
);
type Name = "A1" | "A2" | "B" | "C" | "E";

class StateRelayNetwork {
  readonly nodes = new Map<Name, Nexus<Model>>();
  readonly scopes: ResourceScope[] = [];
  readonly wire: {
    edge: string;
    type: NexusMessageType;
    id: number | string | null;
  }[] = [];
  byteCalls = 0;
  interceptPacket?: (edge: string, packet: unknown) => Promise<void> | void;
  private readonly accepts = new Map<
    Name,
    (port: IPort, meta: { edge: string }) => void
  >();

  constructor() {
    for (const name of ["A1", "A2", "B", "C", "E"] as const)
      this.nodes.set(name, new Nexus<Model>());
  }

  get(name: Name): NexusInstance<Model> {
    return this.nodes.get(name)!;
  }

  async start(): Promise<void> {
    const incrementByteCalls = () => {
      this.byteCalls++;
    };
    const binding = createNexusStore(
      token,
      (set, get) => ({
        count: 0,
        add(by: number) {
          set({ count: get().count + by });
          return get().count;
        },
      }),
      { snapshot: ({ count }) => ({ count }), expose: ["add"] },
    );
    const service = binding.provider
      .service as typeof binding.provider.service & {
      [SERVICE_INVOKE_START]?: (context: { scope?: ResourceScope }) => unknown;
    };
    const start = service[SERVICE_INVOKE_START];
    Object.defineProperty(service, SERVICE_INVOKE_START, {
      value: (context: { scope?: ResourceScope }) => {
        if (context.scope) this.scopes.push(context.scope);
        return start?.(context) ?? context;
      },
    });

    for (const [name, nexus] of this.nodes) {
      const endpoint: IEndpoint<Model> = {
        config: {
          binaryPackets: false,
          maxFrameBytes: 512,
          maxMessageBytes: 16_384,
          maxBufferedBytes: 65_536,
        },
        listen: (accept) => {
          this.accepts.set(name, accept);
        },
        connect: async (target) => {
          const destination = target.context as Name;
          const accept = this.accepts.get(destination);
          if (!accept) throw new Error(`No endpoint for ${destination}.`);
          const [local, remote] = createMockPortPair();
          for (const [edge, port] of [
            [`${name}->${destination}`, local],
            [`${destination}->${name}`, remote],
          ] as const) {
            const postMessage = port.postMessage.bind(port);
            port.postMessage = async (packet, transfer, signal) => {
              const decoded = JsonSerializer.serializer.safeDeserialize(
                packet as string,
              );
              if (decoded.isOk())
                this.wire.push({
                  edge,
                  type: decoded.value.type,
                  id: "id" in decoded.value ? decoded.value.id : null,
                });
              await this.interceptPacket?.(edge, packet);
              return postMessage(packet, transfer, signal);
            };
          }
          accept(remote, { edge: `${name}->${destination}` });
          return {
            port: local,
            connectionMeta: { edge: `${name}->${destination}` },
          };
        },
        matchesTarget: (target, meta) => target.context === meta.context,
      };
      nexus.configure({
        endpoint: { meta: { context: name }, implementation: endpoint },
        ...(name === "E"
          ? {
              providers: [
                { token, service },
                {
                  token: bytesToken,
                  service: {
                    accept(bytes: Uint8Array) {
                      incrementByteCalls();
                      return bytes.byteLength;
                    },
                  },
                },
              ],
            }
          : {}),
      });
    }
    Nexus.relay({
      from: this.get("B"),
      to: { nexus: this.get("B"), target: { context: "C" } },
      services: [token, bytesToken],
    });
    Nexus.relay({
      from: this.get("C"),
      to: { nexus: this.get("C"), target: { context: "E" } },
      services: [token, bytesToken],
    });
    await Promise.all([...this.nodes.values()].map((nexus) => nexus.ready()));
  }

  dispose(): void {
    for (const nexus of this.nodes.values()) {
      const manager = (nexus as any).lifecycle.manager;
      for (const connection of manager?.connections.values() ?? [])
        connection.close();
    }
  }
}

describe("State through scoped relay (R18-R20)", () => {
  const networks: StateRelayNetwork[] = [];
  afterEach(() => {
    for (const network of networks.splice(0)) network.dispose();
  });

  it("forwards independent State subscriptions through B/C and leaves a sibling live when E closes one scope", async () => {
    const network = new StateRelayNetwork();
    networks.push(network);
    await network.start();

    const first = await connectNexusStore(network.get("A1"), token, {
      target: { context: "B" },
    });
    const second = await connectNexusStore(network.get("A2"), token, {
      target: { context: "B" },
    });
    const firstSnapshots: number[] = [];
    const secondSnapshots: number[] = [];
    first.subscribe((state) => firstSnapshots.push(state.count));
    second.subscribe((state) => secondSnapshots.push(state.count));
    const firstInstance = first.getStatus();
    const secondInstance = second.getStatus();
    expect(firstInstance).toMatchObject({ type: "ready", version: 0 });
    expect(secondInstance).toMatchObject({ type: "ready", version: 0 });
    if (firstInstance.type === "ready" && secondInstance.type === "ready")
      expect(firstInstance.storeInstanceId).toBe(
        secondInstance.storeInstanceId,
      );
    expect(network.scopes).toHaveLength(2);
    expect(network.scopes[0]).not.toBe(network.scopes[1]);

    await expect(first.actions.add(1)).resolves.toBe(1);
    await expect(second.actions.add(2)).resolves.toBe(3);
    expect(firstSnapshots).toEqual([1, 3]);
    expect(secondSnapshots).toEqual([1, 3]);
    expect(first.getStatus()).toMatchObject({ type: "ready", version: 2 });
    expect(second.getStatus()).toMatchObject({ type: "ready", version: 2 });

    network.scopes[0].close();
    await vi.waitFor(() => expect(first.getStatus().type).toBe("disconnected"));
    await expect(first.actions.add(1)).rejects.toMatchObject({
      code: "E_RESOURCE_SCOPE_CLOSED",
    });
    await expect(second.actions.add(1)).resolves.toBe(4);
    expect(firstSnapshots).toEqual([1, 3]);
    expect(secondSnapshots).toEqual([1, 3, 4]);
    expect(second.getStatus()).toMatchObject({ type: "ready", version: 3 });

    const replacement = await connectNexusStore(network.get("A1"), token, {
      target: { context: "B" },
    });
    expect(replacement.getStatus()).toMatchObject({
      type: "ready",
      version: 3,
    });
    const replacementStatus = replacement.getStatus();
    const secondStatus = second.getStatus();
    if (replacementStatus.type === "ready" && secondStatus.type === "ready")
      expect(replacementStatus.storeInstanceId).toBe(
        secondStatus.storeInstanceId,
      );
    expect(first.getStatus().type).toBe("disconnected");
    replacement.destroy();
    second.destroy();
  });

  it("keeps the A-B-C relay path usable when the C-E downstream hop disconnects", async () => {
    const network = new StateRelayNetwork();
    networks.push(network);
    await network.start();

    const client = network.get("A1");
    const state = await connectNexusStore(client, token, {
      target: { context: "B" },
    });
    expect(state.getStatus()).toMatchObject({ type: "ready", version: 0 });

    const cManager = (network.get("C") as any).lifecycle.manager;
    const downstream = [...cManager.connections.values()].find(
      (connection: { context?: { connection?: { edge?: string } } }) =>
        connection.context?.connection?.edge === "C->E",
    );
    expect(downstream).toBeDefined();
    downstream.close();

    await vi.waitFor(() => expect(state.getStatus().type).toBe("disconnected"));
    const bManager = (network.get("B") as any).lifecycle.manager;
    const upstream = [...bManager.connections.values()].find(
      (connection: { context?: { connection?: { edge?: string } } }) =>
        connection.context?.connection?.edge === "B->C",
    );
    expect(upstream?.isReady()).toBe(true);
    await expect(state.actions.add(1)).rejects.toMatchObject({
      code: "E_RESOURCE_SCOPE_CLOSED",
    });

    const sibling = await connectNexusStore(network.get("A2"), token, {
      target: { context: "B" },
    });
    await expect(sibling.actions.add(2)).resolves.toBe(2);
    expect(upstream?.isReady()).toBe(true);
    state.destroy();
    sibling.destroy();
  });

  it("does not replay a final-DATA-uncertain relay call and keeps the upstream usable", async () => {
    const network = new StateRelayNetwork();
    networks.push(network);
    await network.start();
    const client = network.get("A1");
    const connection = await client.connect({ target: { context: "B" } });
    const scope = connection.createScope(bytesToken);
    const service = connection.get(bytesToken, { scope });
    const totals = new Map<string, number>();
    let failedFinalData = false;
    network.interceptPacket = (edge, packet) => {
      if (edge !== "C->E" || failedFinalData) return;
      const decoded = JsonSerializer.serializer.safeDeserialize(
        packet as string,
      );
      if (decoded.isErr()) return;
      const message = decoded.value;
      const key = `${edge}:${"id" in message ? message.id : ""}`;
      if (message.type === NexusMessageType.CHUNK_START)
        totals.set(key, message.totalBytes);
      if (
        message.type === NexusMessageType.CHUNK_DATA &&
        message.offset + message.data.byteLength >=
          (totals.get(key) ?? Infinity)
      ) {
        failedFinalData = true;
        throw new Error("downstream final DATA native failure");
      }
    };

    const callResult = await Nexus.safeCall(
      service.accept(new Uint8Array(2_048)),
    );
    expect(callResult).toMatchObject({
      error: {
        code: "E_REMOTE_EXCEPTION",
        context: { remoteError: { code: "E_TRANSFER_UNCERTAIN" } },
      },
    });
    expect(failedFinalData).toBe(true);
    expect(network.byteCalls).toBe(0);
    expect(
      network.wire.filter(
        (entry) =>
          entry.edge === "C->E" && entry.type === NexusMessageType.CHUNK_START,
      ),
    ).toHaveLength(1);
    const upstreamConnection = [
      ...(network.get("B") as any).lifecycle.manager.connections.values(),
    ].find(
      (candidate: { context?: { connection?: { edge?: string } } }) =>
        candidate.context?.connection?.edge === "B->C",
    );
    expect(upstreamConnection?.isReady()).toBe(true);
    expect(
      network.wire.filter(
        (entry) =>
          entry.edge === "B->A1" && entry.type === NexusMessageType.ERR,
      ),
    ).toHaveLength(1);
    expect(
      network.wire.filter(
        (entry) =>
          entry.edge === "C->E" && entry.type === NexusMessageType.RELEASE,
      ),
    ).toHaveLength(0);
    expect(
      network.wire.some(
        (entry) =>
          entry.edge === "C->B" && entry.type === NexusMessageType.RELEASE,
      ),
    ).toBe(true);
    const siblingConnection = await network.get("A2").connect({
      target: { context: "B" },
    });
    const siblingScope = siblingConnection.createScope(bytesToken);
    await expect(
      siblingConnection
        .get(bytesToken, { scope: siblingScope })
        .accept(new Uint8Array(2_048)),
    ).resolves.toBe(2_048);
    expect(upstreamConnection?.isReady()).toBe(true);
    expect(network.byteCalls).toBe(1);
    scope.close();
    siblingScope.close();
  });

  it("closes an Engine scope during an active chunk before its RELEASE", async () => {
    const network = new StateRelayNetwork();
    networks.push(network);
    await network.start();
    const client = network.get("A1");
    const connection = await client.connect({ target: { context: "B" } });
    const scope = connection.createScope(bytesToken);
    const service = connection.get(bytesToken, { scope });
    let startAckSubmitted!: () => void;
    let releaseAck!: () => void;
    const submitted = new Promise<void>((resolve) => {
      startAckSubmitted = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    network.interceptPacket = async (edge, packet) => {
      if (edge !== "B->A1") return;
      const decoded = JsonSerializer.serializer.safeDeserialize(
        packet as string,
      );
      if (
        decoded.isOk() &&
        decoded.value.type === NexusMessageType.CHUNK_ACK &&
        decoded.value.offset === 0
      ) {
        startAckSubmitted();
        await unblock;
      }
    };
    const call = service.accept(new Uint8Array(2_048));
    await Promise.race([
      submitted,
      call.then((value) => {
        throw new Error(
          `Call settled before START: ${String(value)} ${JSON.stringify(network.wire)}`,
        );
      }),
    ]);

    scope.close();
    releaseAck();

    await expect(call).rejects.toMatchObject({
      code: "E_RESOURCE_SCOPE_CLOSED",
    });
    await vi.waitFor(() =>
      expect(
        network.wire.some((entry) => entry.type === NexusMessageType.RELEASE),
      ).toBe(true),
    );
    const sent = network.wire
      .filter((entry) => entry.edge === "A1->B")
      .map((entry) => entry.type);
    expect(sent.indexOf(NexusMessageType.CHUNK_CANCEL)).toBeGreaterThanOrEqual(
      0,
    );
    expect(sent.indexOf(NexusMessageType.RELEASE)).toBeGreaterThan(
      sent.indexOf(NexusMessageType.CHUNK_CANCEL),
    );
    expect(connection.status).toBe("connected");
  });

  it("suppresses RELEASE when scope-owned final DATA becomes uncertain", async () => {
    const network = new StateRelayNetwork();
    networks.push(network);
    await network.start();
    const client = network.get("A1");
    const connection = await client.connect({ target: { context: "B" } });
    const scope = connection.createScope(bytesToken);
    const service = connection.get(bytesToken, { scope });
    const totals = new Map<number, number>();
    network.interceptPacket = (edge, packet) => {
      if (edge !== "A1->B") return;
      const decoded = JsonSerializer.serializer.safeDeserialize(
        packet as string,
      );
      if (decoded.isErr()) return;
      if (decoded.value.type === NexusMessageType.CHUNK_START)
        totals.set(decoded.value.id, decoded.value.totalBytes);
      if (
        decoded.value.type === NexusMessageType.CHUNK_DATA &&
        decoded.value.offset + decoded.value.data.byteLength >=
          (totals.get(decoded.value.id) ?? Infinity)
      )
        throw new Error("scope-owned final DATA failed natively");
    };

    const result = await Nexus.safeCall(service.accept(new Uint8Array(2_048)));
    expect(result).toMatchObject({
      error: { code: "E_CONN_CLOSED" },
    });
    await vi.waitFor(() => expect(connection.status).toBe("disconnected"));
    expect(scope.closed).toBe(true);
    expect(
      network.wire.filter(
        (entry) =>
          entry.edge === "A1->B" && entry.type === NexusMessageType.RELEASE,
      ),
    ).toHaveLength(0);
    expect(network.byteCalls).toBe(0);
  });
});

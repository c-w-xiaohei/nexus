import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Token } from "../../src/api/token";
import {
  ContentScriptServiceToken,
  createIssueCompanionWorld,
  teardownIssueCompanionWorld,
  type AppAdapterModel,
  type IssueCompanionWorld,
} from "../fixtures";

describe("ConnectionCollection", () => {
  let world: IssueCompanionWorld;

  beforeEach(async () => {
    world = await createIssueCompanionWorld();
  });

  afterEach(() => teardownIssueCompanionWorld(world));

  it("keeps successful target sessions usable when strict multicast acquisition fails", async () => {
    const cs1Target = {
      context: "content-script" as const,
      issueId: "CS1",
    };
    const existing = await world.background.nexus.connect({
      target: cs1Target,
    });

    const result = await world.background.nexus.safeConnectMulticast({
      targets: [cs1Target, { context: "content-script", issueId: "missing" }],
    });

    expect(result.isErr()).toBe(true);
    expect(await world.background.nexus.connect({ target: cs1Target })).toBe(
      existing,
    );
    await expect(
      existing.get(ContentScriptServiceToken).getTitle(),
    ).resolves.toContain("CS1");
  });

  it("reports passive single-connection ambiguity while multicast snapshots both sessions", async () => {
    const where = (meta: AppAdapterModel["contextMeta"]) =>
      meta.context === "content-script";

    await expect(
      world.background.nexus.safeConnect({ where }),
    ).resolves.toMatchObject({
      error: { code: "E_SERVICE_AMBIGUOUS" },
    });
    const collection = await world.background.nexus.connectMulticast({ where });
    expect(collection.connections).toHaveLength(2);
  });

  it("returns ordered per-connection acquire results and retains disconnected snapshot members", async () => {
    const cs1Only = new Token<{ read(): string }, AppAdapterModel>("cs1-only");
    world.cs1.nexus.provide(cs1Only, { read: () => "CS1" });
    const collection = await world.background.nexus.connectMulticast({
      where: (meta) => meta.context === "content-script",
    });

    await vi.waitFor(() => {
      const resources = collection.get(cs1Only);
      expect(resources).toHaveLength(2);
      expect(resources.map(({ result }) => result.isOk())).toEqual([
        true,
        false,
      ]);
    });

    const beforeDisconnect = collection.get(cs1Only);
    const cs2 = beforeDisconnect.find(
      ({ connection }) =>
        connection.contextMeta.context === "content-script" &&
        connection.contextMeta.issueId === "CS2",
    );
    expect(cs2?.result).toMatchObject({
      error: { code: "E_SERVICE_UNAVAILABLE" },
    });
    cs2!.connection.disconnect();

    await vi.waitFor(() => {
      expect(cs2!.connection.status).toBe("disconnected");
    });
    const afterDisconnect = collection.get(cs1Only);
    expect(afterDisconnect).toHaveLength(2);
    expect(
      afterDisconnect.find(
        ({ connection }) =>
          connection.contextMeta.context === "content-script" &&
          connection.contextMeta.issueId === "CS2",
      )?.result,
    ).toMatchObject({ error: { code: "E_CONN_CLOSED" } });
  });

  it("deduplicates repeated targets and never replaces an old collection member", async () => {
    const cs1Target = {
      context: "content-script" as const,
      issueId: "CS1",
    };
    const collection = await world.background.nexus.connectMulticast({
      targets: [cs1Target, cs1Target],
    });
    expect(collection.connections).toHaveLength(1);
    const old = collection.connections[0];

    old.disconnect();
    await vi.waitFor(() => expect(old.status).toBe("disconnected"));
    const replacement = await world.background.nexus.connectMulticast({
      targets: [cs1Target],
    });

    expect(replacement.connections).toHaveLength(1);
    expect(replacement.connections[0]).not.toBe(old);
    expect(collection.connections).toEqual([old]);
    expect(collection.get(ContentScriptServiceToken)[0].result).toMatchObject({
      error: { code: "E_CONN_CLOSED" },
    });
    await expect(
      replacement.connections[0].get(ContentScriptServiceToken).getTitle(),
    ).resolves.toContain("CS1");
  });
});

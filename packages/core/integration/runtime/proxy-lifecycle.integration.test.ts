import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Nexus } from "../../src/api/nexus";
import { NexusUsageError } from "../../src/errors";
import type { IssueCompanionWorld } from "../fixtures";
import {
  BackgroundServiceToken,
  createIssueCompanionWorld,
  findLogicalConnection,
  teardownIssueCompanionWorld,
} from "../fixtures";

describe("public proxy lifecycle acquisition parity", () => {
  let world: IssueCompanionWorld;

  beforeEach(async () => {
    world = await createIssueCompanionWorld();
  });

  afterEach(() => {
    teardownIssueCompanionWorld(world);
    world = undefined as never;
  });

  it("reports status for successful create, safeCreate, select, and safeSelect", async () => {
    const create = await world.popup.nexus.create(BackgroundServiceToken, {
      target: { context: "background" },
    });
    const safeCreate = await world.popup.nexus.safeCreate(
      BackgroundServiceToken,
      { target: { context: "background" } },
    );
    const select = await world.popup.nexus.select(BackgroundServiceToken);
    const safeSelect = await world.popup.nexus.safeSelect(
      BackgroundServiceToken,
    );

    expect(safeCreate.isOk()).toBe(true);
    expect(safeSelect.isOk()).toBe(true);
    const roots = [create, safeCreate.unwrap(), select, safeSelect.unwrap()];
    for (const root of roots) {
      expect(Nexus.getProxyStatus(root)).toEqual({
        type: "active",
        selection: "current",
      });
    }
  });

  it("does not fabricate observable lifecycle roots for safe acquisition errors", async () => {
    const create = await world.popup.nexus.safeCreate({} as never, {} as never);
    const select = await world.popup.nexus.safeSelect({} as never);

    expect(create.isErr()).toBe(true);
    expect(select.isErr()).toBe(true);
    expect(() => Nexus.getProxyStatus({})).toThrow(NexusUsageError);
  });

  it("reports real stale and disconnect transitions to public listeners", async () => {
    const root = await world.popup.nexus.create(BackgroundServiceToken, {
      target: { context: "background" },
      where: (identity) =>
        identity.context === "background" && identity.version === "1.0.0",
    });
    const statuses: string[] = [];
    Nexus.subscribeProxyStatus(root, () => {
      statuses.push(Nexus.getProxyStatus(root).type);
    });

    await world.background.nexus.updateIdentity({ version: "2.0.0" });
    await vi.waitFor(() => {
      expect(Nexus.getProxyStatus(root)).toEqual({
        type: "active",
        selection: "stale",
      });
      expect(statuses).toEqual(["active"]);
    });

    const connection = findLogicalConnection(
      world.popup,
      (candidate) => candidate.remoteIdentity?.context === "background",
    );
    expect(connection).toBeDefined();
    connection!.close();

    expect(Nexus.getProxyStatus(root)).toMatchObject({
      type: "disconnected",
    });
    expect(statuses).toEqual(["active", "disconnected"]);
  });

  it("rejects descendants, multicast roots, resource-like values, and plain values", async () => {
    const root = await world.popup.nexus.create(BackgroundServiceToken, {
      target: { context: "background" },
    });
    const multicast = await world.popup.nexus.createMulticast(
      BackgroundServiceToken,
      { targets: [{ context: "background" }] },
    );
    const resource = world.popup.nexus.ref({ value: 1 });

    for (const value of [
      root.getSettings,
      multicast,
      resource,
      {},
      () => undefined,
    ]) {
      expect(() => Nexus.getProxyStatus(value as object)).toThrow(
        NexusUsageError,
      );
    }
  });
});

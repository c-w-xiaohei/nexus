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

  it("reports status for service proxies acquired from connections", async () => {
    const connection = await world.popup.nexus.connect({
      target: { context: "background" },
    });
    const safeConnection = await world.popup.nexus.safeConnect({
      target: { context: "background" },
    });
    const roots = [
      connection.get(BackgroundServiceToken),
      safeConnection.unwrap().get(BackgroundServiceToken),
    ];
    for (const root of roots) {
      expect(Nexus.getProxyStatus(root)).toEqual({
        type: "active",
        selection: "current",
      });
    }
  });

  it("does not fabricate observable lifecycle roots for safe acquisition errors", async () => {
    const connection = await world.popup.nexus.safeConnect({
      target: null as never,
    });

    expect(connection.isErr()).toBe(true);
    expect(() => Nexus.getProxyStatus({})).toThrow(NexusUsageError);
  });

  it("reports real stale and disconnect transitions to public listeners", async () => {
    const root = (
      await world.popup.nexus.connect({
        target: { context: "background" },
        where: (identity) =>
          identity.context === "background" && identity.version === "1.0.0",
      })
    ).get(BackgroundServiceToken);
    const statuses: string[] = [];
    Nexus.subscribeProxyStatus(root, (status) => {
      statuses.push(status.type);
    });

    await world.background.nexus.updateIdentity({ version: "2.0.0" });
    await vi.waitFor(() => {
      expect(Nexus.getProxyStatus(root)).toEqual({
        type: "active",
        selection: "stale",
      });
      expect(statuses).toEqual(["active", "active"]);
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
    expect(statuses).toEqual(["active", "active", "disconnected"]);
  });

  it("does not reapply where to an existing connection after identity changes", async () => {
    const connection = await world.popup.nexus.connect({
      target: { context: "background" },
      where: (identity) =>
        identity.context === "background" && identity.version === "1.0.0",
    });

    await world.background.nexus.updateIdentity({ version: "2.0.0" });

    await expect(
      connection.get(BackgroundServiceToken).getSettings(),
    ).resolves.toEqual({ showAvatars: true, defaultProject: "Nexus" });
  });

  it("rejects descendants, multicast roots, resource-like values, and plain values", async () => {
    const root = (
      await world.popup.nexus.connect({ target: { context: "background" } })
    ).get(BackgroundServiceToken);
    const multicast = await world.popup.nexus.connectMulticast({
      targets: [{ context: "background" }],
    });
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

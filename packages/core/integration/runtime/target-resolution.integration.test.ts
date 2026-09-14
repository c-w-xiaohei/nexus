import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackgroundServiceToken,
  ContentScriptServiceToken,
  createIssueCompanionWorld,
  teardownIssueCompanionWorld,
  type IssueCompanionWorld,
} from "../fixtures";

describe("service connection", () => {
  let world: IssueCompanionWorld;

  beforeEach(async () => {
    world = await createIssueCompanionWorld();
  });
  afterEach(() => teardownIssueCompanionWorld(world));

  it("connectMulticast snapshots matching connections without connecting", async () => {
    const endpoint = (world.background.nexus as any).config.endpoint
      .implementation;
    endpoint.connect.mockClear();
    const resources = (
      await world.background.nexus.connectMulticast({
        where: (meta) => meta.context === "content-script",
      })
    ).get(ContentScriptServiceToken);
    expect(resources).toHaveLength(2);
    expect(resources.every(({ result }) => result.isOk())).toBe(true);
    await expect(
      Promise.all(
        resources.map(({ result }) => {
          if (result.isErr()) throw result.error;
          return result.value.refresh();
        }),
      ),
    ).resolves.toHaveLength(2);
    expect(endpoint.connect).not.toHaveBeenCalled();
  });

  it("connects to the unique available background session", async () => {
    const service = (
      await world.cs1.nexus.connect({ target: { context: "background" } })
    ).get(BackgroundServiceToken);
    await expect(service.getSettings()).resolves.toMatchObject({
      showAvatars: true,
    });
  });
});

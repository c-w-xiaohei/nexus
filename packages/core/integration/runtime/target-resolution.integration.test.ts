import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Token } from "../../src/api/token";
import {
  BackgroundServiceToken,
  ContentScriptServiceToken,
  createIssueCompanionWorld,
  teardownIssueCompanionWorld,
  type IssueCompanionWorld,
  type AppAdapterModel,
  type IContentScriptService,
} from "../fixtures";

describe("service acquisition", () => {
  let world: IssueCompanionWorld;

  beforeEach(async () => {
    world = await createIssueCompanionWorld();
  });
  afterEach(() => teardownIssueCompanionWorld(world));

  it("uses Token.defaultTarget for exact create", async () => {
    const token = new Token<IContentScriptService, AppAdapterModel>(
      ContentScriptServiceToken.id,
      {
        defaultTarget: { context: "content-script", issueId: "CS1" },
      },
    );
    const service = await world.background.nexus.create(token);
    await expect(service.getTitle()).resolves.toContain("CS1");
  });

  it("selectMulticast snapshots available providers without connecting", async () => {
    const endpoint = (world.background.nexus as any).config.endpoint
      .implementation;
    endpoint.connect.mockClear();
    const service = await world.background.nexus.selectMulticast(
      ContentScriptServiceToken,
      { where: (meta) => meta.context === "content-script" },
    );
    await expect(service.refresh()).resolves.toHaveLength(2);
    expect(endpoint.connect).not.toHaveBeenCalled();
  });

  it("select returns no-match when no provider matches", async () => {
    const result = await world.background.nexus.safeSelect(
      ContentScriptServiceToken,
      { where: () => false },
    );
    expect(result).toMatchObject({ error: { code: "E_SERVICE_NO_MATCH" } });
  });

  it("create rejects without a target source", async () => {
    const result = await world.background.nexus.safeCreate(
      new Token<object>("missing"),
    );
    expect(result).toMatchObject({ error: { code: "E_TARGET_REQUIRED" } });
  });

  it("selects the unique available background provider", async () => {
    const service = await world.cs1.nexus.select(BackgroundServiceToken);
    await expect(service.getSettings()).resolves.toMatchObject({
      showAvatars: true,
    });
  });
});

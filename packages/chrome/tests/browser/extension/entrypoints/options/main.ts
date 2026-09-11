import { usingOptionsPage } from "@nexus-js/chrome";
import type { FixtureAppMeta } from "../../shared/contracts";
import { startPage } from "../../shared/page";

const runId = new URLSearchParams(location.search).get("runId") ?? "options";
const sessionId = crypto.randomUUID();
const nexus = usingOptionsPage<FixtureAppMeta>({
  app: { fixture: true, sessionId, runId },
});
void startPage("options", nexus, "options", sessionId);

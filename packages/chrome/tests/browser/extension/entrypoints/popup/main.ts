import { usingPopup } from "@nexus-js/chrome";
import type { FixtureAppMeta } from "../../shared/contracts";
import { startPage } from "../../shared/page";

const runId = new URLSearchParams(location.search).get("runId") ?? "popup";
const sessionId = crypto.randomUUID();
const nexus = usingPopup<FixtureAppMeta>({
  app: { fixture: true, sessionId, runId },
});
void startPage("popup", nexus, "popup", sessionId);

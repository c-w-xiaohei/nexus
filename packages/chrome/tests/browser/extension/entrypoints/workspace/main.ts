import { usingExtensionPage } from "@nexus-js/chrome";
import { startPage } from "../../shared/page";

const runId = new URLSearchParams(location.search).get("runId") ?? "workspace";
const sessionId = crypto.randomUUID();
const nexus = usingExtensionPage({
  context: "fixture-workspace",
  app: { fixture: true, sessionId, runId },
});
void startPage("workspace", nexus, "workspace", sessionId);

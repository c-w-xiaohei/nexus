import { usingOptionsPage } from "@nexus-js/chrome";
import type { FixtureAppMeta } from "../../shared/contracts";
import { startPage } from "../../shared/page";
import { sanitizeFixtureError } from "../../shared/runtime";

const runId = new URLSearchParams(location.search).get("runId") ?? "options";
const sessionId = crypto.randomUUID();
const nexus = usingOptionsPage<FixtureAppMeta>({
  app: { fixture: true, sessionId, runId },
});
void startPage("options", nexus, "options", sessionId).catch((error) => {
  const status = document.querySelector("[data-status]");
  if (status)
    status.textContent = `options:error:${sanitizeFixtureError(error)}`;
});

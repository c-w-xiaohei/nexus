import { usingSidePanel } from "@nexus-js/chrome";
import type { FixtureAppMeta } from "../../shared/contracts";
import {
  SidePanelToken,
  SessionToken,
  type UiReceiverIdentity,
} from "../../shared/contracts";
import {
  activeRunKey,
  createReporter,
  fixtureIdentity,
} from "../../shared/runtime";

const sessionId = crypto.randomUUID();
const runId = await readActiveRun();
const identity = fixtureIdentity("sidepanel", window.location, sessionId) ?? {
  participant: "sidepanel",
  runId,
  sessionId,
};

const nexus = usingSidePanel<FixtureAppMeta>({
  app: { fixture: true, runId, sessionId },
});
const receiver: UiReceiverIdentity = {
  participant: "sidepanel",
  sessionId,
};
nexus.provide(SessionToken, { session: async () => sessionId });
nexus.provide(SidePanelToken, { identity: async () => receiver });
const reporter = createReporter(identity);

void nexus.ready().then(async () => {
  await reporter.barrier("provider-live");
  const status = document.querySelector("[data-status]");
  if (status) status.textContent = `sidepanel:ready:${sessionId}`;
});

async function readActiveRun(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stored = await chrome.storage.local.get(activeRunKey);
    const value = stored[activeRunKey];
    if (typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value))
      return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Side Panel fixture run was not initialized");
}

import { usingOffscreenDocument } from "@nexus-js/chrome";
import { SessionToken, WorkspaceToken } from "../../shared/contracts";
import {
  createReporter,
  isFixtureRunId,
  sanitizeFixtureError,
} from "../../shared/runtime";

const sessionId = crypto.randomUUID();
const requestedRunId = new URLSearchParams(location.search).get("runId");
void bootstrap();

async function bootstrap(): Promise<void> {
  const runId = isFixtureRunId(requestedRunId) ? requestedRunId : undefined;
  if (!isFixtureRunId(runId)) {
    await chrome.runtime.sendMessage({
      kind: "offscreen-init",
      runId: "invalid",
      sessionId,
    });
    return;
  }
  const offscreenIdentity = { participant: "offscreen", runId, sessionId };
  const reporter = createReporter(
    offscreenIdentity,
    undefined,
    async (event) => {
      const response = await chrome.runtime.sendMessage({
        kind: "offscreen-diagnostic",
        event,
      });
      if (!response?.ok) throw new Error("offscreen diagnostic rejected");
    },
  );
  try {
    await reporter.barrier("offscreen-bootstrap-started");
    const initialized = await chrome.runtime.sendMessage({
      kind: "offscreen-init",
      runId: offscreenIdentity.runId,
      sessionId: offscreenIdentity.sessionId,
    });
    if (!initialized?.ok) {
      await reporter.error("offscreen-init-rejected");
      return;
    }
    const nexus = usingOffscreenDocument({
      reason: "fixture export",
      app: { fixture: true, sessionId, runId },
    });
    nexus.provide(SessionToken, {
      session: async () => offscreenIdentity.sessionId,
    });
    await nexus.ready();
    // UIClientEndpoint publishes static providers over this public background route.
    await nexus.create(WorkspaceToken);
    await reporter.barrier("provider-live");
    const ready = await chrome.runtime.sendMessage({
      kind: "ui-ready",
      runId: offscreenIdentity.runId,
      sessionId: offscreenIdentity.sessionId,
      participant: offscreenIdentity.participant,
    });
    if (!ready?.ok) throw new Error("offscreen readiness rejected");
  } catch (error) {
    await reporter.error(sanitizeFixtureError(error));
  }
}

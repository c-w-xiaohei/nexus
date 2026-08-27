import { usingOptionsPage } from "@nexus-js/chrome";
import { startPage } from "../../shared/page";

const runId = new URLSearchParams(location.search).get("runId") ?? "options";
const sessionId = crypto.randomUUID();
const nexus = usingOptionsPage({ app: { fixture: true, sessionId, runId } });
void startPage("options", nexus, "options", sessionId);

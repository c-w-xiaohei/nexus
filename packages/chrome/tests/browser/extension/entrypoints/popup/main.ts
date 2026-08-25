import { usingPopup } from "@nexus-js/chrome";
import { startPage } from "../../shared/page";

const runId = new URLSearchParams(location.search).get("runId") ?? "popup";
const sessionId = crypto.randomUUID();
const nexus = usingPopup({ app: { fixture: true, sessionId, runId } });
void startPage("popup", nexus, "popup", sessionId);

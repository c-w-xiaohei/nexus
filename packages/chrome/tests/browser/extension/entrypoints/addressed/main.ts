import { startAddressedPage } from "../../shared/addressed";

const params = new URLSearchParams(location.search);
const endpointId = params.get("endpointId");
const runId = params.get("runId");

if (endpointId && runId) void startAddressedPage(endpointId, runId);

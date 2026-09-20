import { chromeTarget, usingExtensionPage } from "@nexus-js/chrome";
import {
  AddressedPageToken,
  type AddressedPageMetrics,
  type AddressedPageService,
} from "./addressed-contracts";
import { DocumentToolToken } from "./contracts";

export async function startAddressedPage(
  endpointId: string,
  runId: string,
): Promise<void> {
  const sessionId = crypto.randomUUID();
  const nexus = usingExtensionPage(
    {
      context: "fixture-addressed",
      app: { fixture: true, sessionId, runId },
    },
    { endpointId },
  );
  let retainedPeer: Awaited<ReturnType<typeof nexus.connect>> | undefined;
  let nativeOnConnectCount = 0;
  let nexusReadyOnConnectCount = 0;
  let providerInvocationCount = 0;
  const connectionIds: string[] = [];
  chrome.runtime.onConnect.addListener(() => {
    nativeOnConnectCount += 1;
  });
  nexus.onConnect((connection) => {
    nexusReadyOnConnectCount += 1;
    connectionIds.push(connection.id);
  });

  const service: AddressedPageService = {
    identity: async () => {
      providerInvocationCount += 1;
      return { endpointId, sessionId };
    },
    echo: async (value) => {
      providerInvocationCount += 1;
      return `${endpointId}:${value}`;
    },
  };
  nexus.provide(AddressedPageToken, service);
  await nexus.ready();

  const status = document.querySelector("[data-status]");
  if (status) status.textContent = `addressed:ready:${endpointId}`;

  const result = document.querySelector<HTMLOutputElement>("[data-result]");
  let sequence = 0;
  window.addEventListener("nexus-addressed-command", (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as {
      readonly command?: unknown;
      readonly endpointId?: unknown;
      readonly runId?: unknown;
      readonly value?: unknown;
    };
    if (detail.runId !== runId || typeof detail.command !== "string") return;
    const currentSequence = ++sequence;
    void executeCommand(
      detail.command,
      typeof detail.endpointId === "string" ? detail.endpointId : undefined,
      typeof detail.value === "string" ? detail.value : undefined,
    )
      .then((value) =>
        writeResult(result, currentSequence, { ok: true, value }),
      )
      .catch((error: unknown) =>
        writeResult(result, currentSequence, {
          ok: false,
          code:
            error && typeof error === "object" && "code" in error
              ? String((error as { code: unknown }).code)
              : error instanceof Error
                ? error.message
                : String(error),
        }),
      );
  });

  async function executeCommand(
    command: string,
    targetEndpointId: string | undefined,
    value: string | undefined,
  ): Promise<unknown> {
    if (command === "identity") return await service.identity();
    if (command === "echo") return await service.echo(value ?? "value");
    if (command === "metrics") {
      const metrics: AddressedPageMetrics = {
        nativeOnConnectCount,
        nexusReadyOnConnectCount,
        providerInvocationCount,
        connectionIds: [...connectionIds],
      };
      return metrics;
    }
    if (command === "incoming-count") return nativeOnConnectCount;
    if (command === "raw-unrelated-port") {
      const port = chrome.runtime.connect({ name: "unrelated-raw-port" });
      port.disconnect();
      return "raw-disconnected";
    }
    if (command === "call-peer") {
      if (!targetEndpointId) throw new Error("missing target endpoint ID");
      return await callPeer(targetEndpointId);
    }
    if (command === "retain-peer") {
      if (!targetEndpointId) throw new Error("missing target endpoint ID");
      const connection = await nexus.connect({
        target: chromeTarget.extensionPage({ endpointId: targetEndpointId }),
      });
      retainedPeer = connection;
      return await connection.get(AddressedPageToken).identity();
    }
    if (command === "invoke-retained-peer") {
      if (!retainedPeer) throw new Error("peer connection was not retained");
      return await retainedPeer.get(AddressedPageToken).identity();
    }
    if (command === "call-content") {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) =>
        candidate.url?.includes(`runId=${encodeURIComponent(runId)}`),
      );
      if (tab?.id === undefined) throw new Error("fixture tab was not found");
      const connection = await nexus.connect({
        target: chromeTarget.contentFrame({ tabId: tab.id, frameId: 0 }),
      });
      return await connection.get(DocumentToolToken).identity();
    }
    throw new Error(`unsupported addressed command: ${command}`);
  }

  async function callPeer(targetEndpointId: string): Promise<unknown> {
    const connection = await nexus.connect({
      target: chromeTarget.extensionPage({ endpointId: targetEndpointId }),
    });
    return await connection.get(AddressedPageToken).identity();
  }
}

function writeResult(
  output: HTMLOutputElement | null,
  sequence: number,
  value: unknown,
): void {
  if (!output) return;
  output.value = JSON.stringify(value);
  output.dataset.sequence = String(sequence);
}

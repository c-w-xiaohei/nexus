import type { BrowserContext } from "@playwright/test";

export interface WorkerTarget {
  readonly targetId: string;
  readonly url: string;
}

export class ServiceWorkerController {
  public constructor(private readonly context: BrowserContext) {}

  public async capture(extensionId: string): Promise<WorkerTarget> {
    const browser = this.context.browser();
    if (!browser)
      throw new Error("Persistent context has no browser CDP connection");
    const cdp = await browser.newBrowserCDPSession();
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const { targetInfos } = await cdp.send("Target.getTargets");
        const target = targetInfos.find(
          (candidate) =>
            candidate.type === "service_worker" &&
            new URL(candidate.url).host === extensionId &&
            candidate.url.endsWith("/background.js"),
        );
        if (target) return { targetId: target.targetId, url: target.url };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        "Extension service worker target was not found within 5000ms",
      );
    } finally {
      await cdp.detach();
    }
  }

  public async closeAfterPending(target: WorkerTarget): Promise<void> {
    const browser = this.context.browser();
    if (!browser)
      throw new Error("Persistent context has no browser CDP connection");
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { targetInfos: beforeClose } = await cdp.send("Target.getTargets");
      const current = beforeClose.find(
        (candidate) => candidate.targetId === target.targetId,
      );
      if (!current || current.url !== target.url) {
        throw new Error("Captured worker target changed before close");
      }
      const result = await cdp.send("Target.closeTarget", {
        targetId: target.targetId,
      });
      if (!result.success)
        throw new Error("Target.closeTarget was not accepted");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const { targetInfos } = await cdp.send("Target.getTargets");
        if (
          !targetInfos.some(
            (candidate) => candidate.targetId === target.targetId,
          )
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        "Target.closeTarget did not destroy the extension worker",
      );
    } finally {
      await cdp.detach();
    }
  }
}

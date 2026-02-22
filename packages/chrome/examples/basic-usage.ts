/**
 * Basic usage example for Chrome extension with Nexus
 */

import {
  usingBackgroundScript,
  usingContentScript,
  usingPopup,
  nexus,
  Expose,
  Token,
  type ChromeUserMeta,
} from "@nexus/chrome-adapter";

// Shared service interface and token
interface ITabService {
  getCurrentTab(): Promise<chrome.tabs.Tab | null>;
  executeScript(tabId: number, code: string): Promise<any>;
  sendNotification(message: string): Promise<void>;
}

const TabServiceToken = new Token<ITabService>("tab-service");

// ===== Background Script =====
// background.ts
export function setupBackground() {
  // Configure Nexus for background context
  usingBackgroundScript();

  // Implement and expose the service
  @Expose(TabServiceToken)
  class TabService implements ITabService {
    async getCurrentTab() {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return tabs[0] || null;
    }

    async executeScript(tabId: number, code: string) {
      return await chrome.scripting.executeScript({
        target: { tabId },
        func: new Function(code),
      });
    }

    async sendNotification(message: string) {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "icon.png",
        title: "Extension Notification",
        message,
      });
    }
  }

  console.log("Background script initialized with Nexus");
}

// ===== Content Script =====
// content.ts
export async function setupContentScript() {
  // Configure Nexus for content script context
  usingContentScript();

  // Get the background service
  const tabService = await nexus.create(TabServiceToken, {
    target: { descriptor: { context: "background" } },
  });

  // Use the service
  const currentTab = await tabService.getCurrentTab();
  console.log("Current tab from content script:", currentTab);

  // Send notification when page loads
  await tabService.sendNotification(`Page loaded: ${window.location.href}`);

  // Update activity status based on visibility
  document.addEventListener("visibilitychange", () => {
    void nexus.updateIdentity({ isActive: !document.hidden });
  });
}

// ===== Popup =====
// popup.ts
export async function setupPopup() {
  // Configure Nexus for popup context
  await usingPopup();

  // Get the background service
  const tabService = await nexus.create(TabServiceToken, {
    target: { descriptor: { context: "background" } },
  });

  // Example: Execute script in current tab
  document
    .getElementById("execute-btn")
    ?.addEventListener("click", async () => {
      const currentTab = await tabService.getCurrentTab();
      if (currentTab?.id) {
        await tabService.executeScript(
          currentTab.id,
          'console.log("Hello from popup via background!");',
        );
      }
    });

  // Example: Send notification
  document.getElementById("notify-btn")?.addEventListener("click", async () => {
    await tabService.sendNotification("Hello from popup!");
  });
}

// ===== Advanced: Multi-cast to Content Scripts =====
export async function broadcastToContentScripts() {
  usingBackgroundScript();

  // Create multicast proxy to all content scripts
  const contentScripts = await nexus.createMulticast(TabServiceToken, {
    target: { matcher: "any-content-script" },
    strategy: "all",
  });

  // This will call the method on all connected content scripts
  await contentScripts.sendNotification(
    "Broadcast message to all content scripts!",
  );
}

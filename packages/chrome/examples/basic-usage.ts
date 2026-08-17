/**
 * Basic usage example for Chrome extension with Nexus
 */

import {
  usingBackgroundScript,
  usingContentScript,
  usingPopup,
  nexus,
  Token,
  chromeTarget,
  whereContentScript,
} from "@nexus-js/chrome";

// Shared service interface and token
interface ITabService {
  getCurrentTab(): Promise<chrome.tabs.Tab | null>;
  executeScript(tabId: number, message: string): Promise<void>;
  sendNotification(message: string): Promise<void>;
}

interface IContentNotificationService {
  notify(message: string): Promise<void>;
}

const TabServiceToken = new Token<ITabService>("tab-service");
const ContentNotificationToken = new Token<IContentNotificationService>(
  "content-notification",
);

// ===== Background Script =====
// background.ts
export function setupBackground() {
  // Configure Nexus for background context
  const backgroundNexus = usingBackgroundScript();

  // Implement and expose the service
  @backgroundNexus.Expose(TabServiceToken)
  class TabService implements ITabService {
    async getCurrentTab() {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return tabs[0] || null;
    }

    async executeScript(tabId: number, message: string) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (value: string) => {
          console.log(value);
        },
        args: [message],
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
  const contentNexus = usingContentScript();
  const notificationService: IContentNotificationService = {
    async notify(message) {
      console.log("Notification from background:", message);
    },
  };
  contentNexus.provide(ContentNotificationToken, notificationService);

  // Get the background service
  const tabService = await nexus.create(TabServiceToken, {
    target: chromeTarget.background(),
  });

  // Use the service
  const currentTab = await tabService.getCurrentTab();
  console.log("Current tab from content script:", currentTab);

  // Send notification when page loads
  await tabService.sendNotification(`Page loaded: ${window.location.href}`);
}

// ===== Popup =====
// popup.ts
export async function setupPopup() {
  // Configure Nexus for popup context
  usingPopup();

  // Get the background service
  const tabService = await nexus.create(TabServiceToken, {
    target: chromeTarget.background(),
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

// ===== Advanced: Multicast to Content Scripts =====
export async function notifyContentScripts() {
  usingBackgroundScript();

  // Bind to the content-script providers available at selection time.
  const contentScriptProxy = await nexus.selectMulticast(
    ContentNotificationToken,
    {
      where: whereContentScript,
    },
  );

  // This calls every provider captured by the selection snapshot.
  await contentScriptProxy.notify(
    "Multicast message to all selected content scripts!",
  );
}

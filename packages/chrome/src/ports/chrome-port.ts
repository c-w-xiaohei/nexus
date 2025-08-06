import type { IPort } from '@nexus-js/core';

/**
 * Wraps chrome.runtime.Port to implement Nexus IPort interface
 */
export class ChromePort implements IPort {
  private messageHandler?: (data: any) => void;
  private disconnectHandler?: () => void;

  constructor(private port: chrome.runtime.Port) {
    // Set up event listeners
    this.port.onMessage.addListener(this.handleMessage);
    this.port.onDisconnect.addListener(this.handleDisconnect);
  }

  postMessage(data: any): void {
    try {
      this.port.postMessage(data);
    } catch (error) {
      // Port might be disconnected
      console.warn('ChromePort: Failed to send message', error);
    }
  }

  onMessage(handler: (data: any) => void): void {
    this.messageHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  close(): void {
    this.port.disconnect();
  }

  private handleMessage = (data: any) => {
    if (this.messageHandler) {
      this.messageHandler(data);
    }
  };

  private handleDisconnect = () => {
    if (this.disconnectHandler) {
      this.disconnectHandler();
    }
  };

  /**
   * Get the underlying chrome.runtime.Port for advanced usage
   */
  get nativePort(): chrome.runtime.Port {
    return this.port;
  }
}

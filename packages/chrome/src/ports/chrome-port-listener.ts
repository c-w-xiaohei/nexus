import { isNexusChromePortName } from "./chrome-port-name.js";

const MAX_PENDING_PORTS = 32;

/** Install immediately, then release matching ports once receiver names resolve. */
export function listenForChromePort(
  expectedName: string | Promise<string>,
  handler: (port: chrome.runtime.Port) => void,
): { readonly ready: Promise<void>; stop(): void } {
  const pendingName =
    typeof expectedName === "string" ? undefined : expectedName;
  let acceptedName =
    typeof expectedName === "string" ? expectedName : undefined;
  let stopped = false;
  const pendingPorts = acceptedName
    ? undefined
    : new Set<chrome.runtime.Port>();
  const listener = (port: chrome.runtime.Port) => {
    if (stopped || !isNexusChromePortName(port.name)) return;
    if (acceptedName === undefined) {
      if (!pendingPorts || pendingPorts.size >= MAX_PENDING_PORTS) return;
      pendingPorts.add(port);
      port.onDisconnect.addListener(() => pendingPorts.delete(port));
      return;
    }
    if (port.name !== acceptedName) return;
    handler(port);
  };

  chrome.runtime.onConnect.addListener(listener);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    chrome.runtime.onConnect.removeListener(listener);
    pendingPorts?.clear();
  };
  const ready = acceptedName
    ? Promise.resolve()
    : pendingName!.then((resolved) => {
        if (stopped) return;
        acceptedName = resolved;
        for (const port of pendingPorts ?? []) {
          if (port.name === acceptedName) handler(port);
        }
        pendingPorts?.clear();
      });

  return {
    ready: ready.catch((error) => {
      stop();
      throw error;
    }),
    stop,
  };
}

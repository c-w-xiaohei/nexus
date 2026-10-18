/** Whether this extension can carry copied binary packets over runtime/tabs ports. */
export function supportsBinaryMessaging(): boolean {
  // Client Hints distinguish Google Chrome from browsers whose UA also says
  // "Chrome". Unknown runtimes keep the JSON/Base64 path; no UA guessing.
  const navigatorWithHints = globalThis.navigator as
    | (Navigator & {
        readonly userAgentData?: {
          readonly brands: readonly { brand: string; version: string }[];
        };
      })
    | undefined;
  const version = navigatorWithHints?.userAgentData?.brands.find(
    ({ brand }) => brand === "Google Chrome",
  )?.version;
  if (!version || !/^\d+$/.test(version) || Number(version) < 152) {
    return false;
  }

  // The announcement says 148, but that implementation was Canary-only.
  // Stable support is verified against Chromium 152.0.7977.64:
  // https://github.com/chromium/chromium/blob/152.0.7977.64/extensions/common/api/_manifest_features.json
  const manifest = chrome.runtime.getManifest();
  return (
    manifest.manifest_version === 3 &&
    manifest.message_serialization === "structured_clone"
  );
}

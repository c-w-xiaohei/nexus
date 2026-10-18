---
"@nexus-js/chrome": patch
---

Automatically use copied binary packets on Google Chrome 152+ when an MV3 extension enables `message_serialization: "structured_clone"`. Detect the browser through User-Agent Client Hints and retain JSON/Base64 for older versions, other browser brands, missing Client Hints, or extensions without the opt-in. Keep transport limits and the public configuration unchanged; transferables remain unsupported.

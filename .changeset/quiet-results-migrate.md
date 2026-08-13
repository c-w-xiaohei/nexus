---
"@nexus-js/core": minor
"@nexus-js/chrome": patch
"@nexus-js/iframe": patch
"@nexus-js/node-ipc": minor
"@nexus-js/react": patch
"@nexus-js/testing": minor
---

Replace the safe async APIs with `Promise<Result<T, E>>` backed by `better-result`, preserving structured Nexus error behavior and package loading compatibility.

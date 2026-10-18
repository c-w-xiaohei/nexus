---
"@nexus-js/core": minor
"@nexus-js/iframe": minor
"@nexus-js/testing": patch
---

Core: add local outbound `transfer` options to service handles, providers, and
`Expose`. Transfer original fixed ArrayBuffers and complete Uint8Array backing
buffers through negotiated native attachments. Keep copy as the default and
`ref()` as a traversal boundary. Capture callback/resource policies and share
release state across facades of the same remote identity.

Breaking: transport handshake version 2 requires coordinated upgrades across
all peers and Relay hops. Native transfers must fit a single frame and reject
unsupported capabilities or views without falling back to copy. Native failure
can partially detach sources and closes the affected resource scope when delivery
is uncertain. Virtual ports now reject sends after close. See the Core 2.0 alpha
migration guide for custom endpoint requirements.

Iframe: advertise native ArrayBuffer attachment support with either ordinary
packet mode. Internal packet transfer remains independent of user buffer policy.

Testing: accept the `transfer` handle option in application mocks. Mocks do not
simulate native ownership transfer; use runtime integration tests for detach.

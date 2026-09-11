---
"@nexus-js/chrome": minor
---

Support optional exact `connectTo` startup targets in Chrome helpers.
Custom page helpers accept startup options separately from metadata:
`usingExtensionPage(meta, { connectTo })` and
`createExtensionPageConfig(meta, { connectTo })`. Existing metadata-only calls
are unchanged. Startup dialing requires Core 1.2. The existing declared Core
range is unchanged; this release was verified with the matching Core source.

---
"@nexus-js/core": patch
---

Simplify State action, mirror, handshake, and relay control flow. Keep recoverable
failures in Result pipelines and preserve structured errors at callback boundaries,
without changing the public API or buffered publication contract.

Separate host subscription, action execution, publication, and teardown. Keep
delivery ownership on each subscription, reuse callback timeout handling, and
convert Result errors only at configuration and RPC boundaries.

Settle all outstanding deliveries when a subscription closes instead of racing
each acknowledgement against a separate close promise. Use the actual in-flight
delivery set for the pending budget and keep action execution as a Result workflow.

Derive publication options from their schema input and select State connection
options from Core using schema keys, avoiding duplicate field declarations.

Preserve inferred State failures instead of widening internal Results to Error.
Derive delivery failures from the capture and disconnect paths without changing
the shared error classes.

Use direct async control flow for host actions and subscriptions, and complete
failed captures, sends, and over-budget deliveries through one cleanup path.
Keep delivery completion separate from awaiting it, and preserve shared callback
ownership when terminal acknowledgements arrive after another owner has closed.

Flatten connection acquisition and schema error conversion, derive action errors
from their implementation, and use subscription membership instead of a second
relay closed flag. Preserve connection-generation checks for delayed invocations.

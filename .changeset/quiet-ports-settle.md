---
"@nexus-js/core": patch
---

Preserve early virtual-port messages and disconnects, surface native send failures,
and finish channel cleanup despite observer errors. Unify connection startup
message delivery, settle timed-out dials independently of native connect, and
prevent late authorization from reviving closed sessions. Simplify transport and
serializer pipelines while retaining the existing wire protocol and marking
chunking explicitly as unimplemented.

Track handshake correlation by phase, ignore replayed or unrelated handshake
control packets, and carry expected acquisition failures as Result values.
Release virtual channels when listener attachment fails.

Consolidate incoming/outgoing startup deadlines and settlement in one binding,
and reclaim ports when subscription or logical connection construction fails.

Move processor acquisition, startup buffering and handshake publication into
LogicalConnection.open with a single pre-attachment/session receiver. Keep
ConnectionManager focused on session indexes, authorization policy and
target-level acquisition, with shared candidate filtering and group registration.

Use one lifecycle phase and one startup result per connection, simplify manager
entry-point orchestration, handle publication callback failures, and document
connection and transport entry points with lifecycle-focused JSDoc. Let the
publication queue itself track whether application sends need to wait.

Share REQ/ACK identity authorization and ready publication orchestration. Keep
routing and identity broadcasts in their owning manager methods instead of
passing internal indexes through single-use wrappers.

Rewrite LogicalConnection around expected handshake packets, a state-owned
publication FIFO, an authorization barrier and monotonic provider sets. Preserve
handshake and shutdown contracts while preventing reentrant application sends
from overtaking queued messages. Buffer inbound traffic through attachment so
registration always precedes protocol delivery.

Use abortable publication delays and a shared publication Promise to keep inbound
RPC behind manager registration. Drain reentrant provider additions before
readiness and defer passive capability rejection cleanup until its delivery turn.
Keep the publication Promise stable through activation without serializing
independent RPC. Simplify startup ownership and buffering, unify failure cleanup,
and document synchronous attachment and late acquisition disposal.

Rewrite ConnectionManager around published-session queries, one target acquisition
flow, ordered routing, and colocated lifecycle callbacks. Preserve attachment and
publication indexes, group ordering, and two-pass identity updates. Reserve pending
initialization and target acquisition before entering reentrant adapters.

Remove manager-specific error subclasses in favor of existing Nexus errors,
preserving transport diagnostics and serialized causes while retaining public
acquisition error codes and the endpoint failure cause contract.

Keep manager initialization and dial completion in their initiating async flows,
including cleanup and settlement of shared results. Recover from unexpected
listener startup rejection instead of leaving initialization pending. Express
delayed publication as one async task while preserving synchronous attachment,
passive publication, and authorization ordering.

Make each LogicalConnection own complete authorization context and policy-failure
handling. Replace ID-based lifecycle notifications with session-bearing owner
callbacks and explicit Result-returning attachment/readiness registration. Keep
application traffic behind successful owner registration, including synchronous
reentry, and contain closure observer failures. ConnectionManager shares one
owner interface across sessions and updates indexes without reconstructing peer
state. Handshake initiation uses the session's own local identity.

Remove unreachable send-error classification, duplicate startup error conversion,
redundant publication guards and unused internal error scaffolding. Preserve
native-close reentry checks, shared acquisition and authorization ordering with
deletion-tested regressions. Consolidate overlapping connection tests and replace
synthetic session failures and arbitrary waits with transport failures and explicit
completion signals.

Make VirtualPort the sole owner of channel state, connect settlement, heartbeat
and shutdown. Keep the router focused on admission, routing and replay protection
without changing its wire format. Commit port closure
before reentrant bus calls, release replay history and subscription closures when
the router closes, and correct late-packet regression coverage.

---
"@nexus-js/core": minor
---

Add optional exact `endpoint.connectTo` startup targets. Dials start after
listening without blocking `ready()` or automatically retrying.

Breaking changes in this rapid-iteration release: bind native Zustand stores
with explicit `snapshot` and `expose` options; replace `defineNexusStore` with
plain shared definitions; and use the lifecycle-owning `VirtualPortRouter`
class instead of static context functions. State now uses callback-init
subscriptions and caller-specific fixed-window acknowledgements. Upgrade State
hosts, clients, and relays together; the previous State wire contract is not
compatible. Ordinary RPC and virtual-port wire formats are unchanged.

Ordinary proxy call rejections are no longer automatically observed or logged
by Nexus. Await or catch calls; ignored failures follow the runtime's normal
unhandled-rejection behavior.

See the [1.2 migration guide](https://github.com/c-w-xiaohei/nexus/blob/main/docs/migrations/1.2.md)
for changed signatures, action semantics, and package compatibility.

# Data model and migration coordination

Read the actual migration directory and existing specs before selecting numbers. The clean checkpoint’s source head is 0051. 0052 belongs to the separate deferred waitlist snapshot and remains reserved; do not reuse it just because absent on the clean branch. Never renumber/rewrite an applied migration.

| Lane | Allocation from current build rules |
| --- | --- |
| Core | 0042–0049; 0041 reserved for 0.1b |
| Events | 0050–0059; 0050/0051 committed, 0052 deferred/reserved |
| Places | 0060–0069 |
| Map | 0070–0074 |
| Local | 0075–0079 |
| Imports | 0080–0084; implementation Later |
| Outings | 0085–0094 |
| Trips | 0095–0099 |

Use the integration owner’s latest ledger rather than assuming a number is free. If tooling forbids allocation gaps, stop the affected schema work and report it; do not pull in deferred 0052 to fill a gap.

## Contract constraints

- Existing events remain occurrences with stable IDs; no series follows imply admission. Series generation, DST, edit-this/future and cancellation require the narrowed approved contract.
- One event-first lock order and one capacity definition across free admission, paid hold/fulfillment and capacity edits. No revoke of legacy write grants until all permitted clients/service paths are compatible.
- New outing membership/invite/vote/lock data uses role-separated RLS and real direct-API tests. Append-only history and itinerary versions do not silently overwrite decisions.
- Owner-only saves/photos cannot leak through joined views, recommendation payloads, notifications or share unfurls.
- Demo and Supabase adapters must match the same semantics. Seeds are fictional and separate from real permitted pilot data.

Apply migrations to disposable localhost test databases as documented. Hosted application requires explicit target guards and separate authorization; the handoff is not that authorization.

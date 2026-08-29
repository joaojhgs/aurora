# W7 — Pruning orphaned peer rows, safely

The plan asks W7 to *prune orphaned rows left when a reinstall mints a new stable id*, and
notes that `localStablePeerId` is `aurora-thin-${crypto.randomUUID()}`, so a clear-data
reinstall orphans the old row on Python — visible today as two hosted-web rows.

This note exists because the obvious implementation is an eviction vector. It is written
before the fix so the fix does not have to be discovered to be wrong.

## Why the duplicate happens

`createThinConnectionProfile` (`packages/aurora-ui/src/thin-connection-profile.ts:62-72`) mints
`localStablePeerId` from a fresh `crypto.randomUUID()` whenever no profile is stored. Clearing
site data or reinstalling therefore produces a *new* identity, by design — the old one was
never recoverable, and pretending otherwise would mean persisting an identity somewhere the
user cannot clear.

Python keys a peer row on the stable id: `mesh_peers` is `UNIQUE(peer_id, room_name)`
(`app/services/db/migrations/007_mesh_peer_lifecycle.sql:29-68`). A returning device is a
different `peer_id`, so `upsert_mesh_peer` inserts rather than updates, and the old row
survives with its old approval state. Two rows, one physical device.

## The trap: do not prune on a name match

`node_name` is the only field that visibly correlates the two rows. Matching on it is
**unsafe**, and it is the first thing anyone will reach for.

Any member of the room can choose its own `node_name`. If a name match retired an existing
row, then:

1. Any room member could evict an **approved** peer's row by announcing that peer's name —
   a denial of service against a device the user had already trusted.
2. Worse, having evicted it, the attacker now occupies that name. The user sees one entry
   with the familiar name in a "needs approval" state and approves it, believing they are
   re-approving the device that was there yesterday. The impersonation is completed by the
   user's own hand.

This directly contradicts the plan's invariant that **room membership is not authority — every
peer still needs its own SAS pairing and explicit approval**. A prune that can retire an
approved row on an announced string makes membership authoritative over approval.

## What is safe

**Automatic pruning is safe only for rows that never earned anything.** A row qualifies when
all of these hold:

- `outbound_status = 'pending'` — no local admin ever approved it;
- `inbound_status IN ('unknown', 'pending')` — it never approved us either;
- `outbound_token_id IS NULL` and `inbound_token IS NULL` — no credential exists in either
  direction;
- `last_seen_at` is older than the retention window, or is `NULL` and `first_seen_at` is.

Removing such a row takes nothing away: no human decision, no credential, no reachability. If
the device returns it re-announces and a fresh row appears. This is garbage collection, not
revocation.

**Every other duplicate is a user decision.** A row with `outbound_status = 'approved'`, or
holding a credential in either direction, is never removed automatically — not on a name
match, not on an idle timer, not on a "looks like a reinstall" heuristic. The correct
behaviour is to surface it: show the two entries and let the person retire the one they
recognise as gone. Approval is already a human act; un-approval should be too, and the plan
says forgetting a peer *revokes approval, not reachability*.

## Parity with the SDK

The same rule binds both sides. The SDK's forget path (`forgetSavedPeer()`, committed in
`f3ede57a`) is user-initiated and revokes approval without rotating the room secret. Python's
pruning must not be more aggressive than that: a background job that can retire an approved
row is a background job that can revoke trust without a human, on a signal an attacker
controls.

## Acceptance for the eventual fix

- A stale, never-approved, credential-less row past the retention window is removed.
- **A test that fails loudly:** an approved row whose `node_name` is announced by a *different*
  `peer_id` is not removed, not modified, and does not lose its approval or its token.
- A duplicate that is not auto-prunable is reported to the user rather than silently kept or
  silently removed, in product copy that does not name internal identifiers.
- The retention window is configurable and documented; it is not a magic constant.

## Implemented DB operation

`DB.PruneOrphanedMeshPeerRows` is the bounded garbage-collection operation for this rule.
It accepts `retention_seconds` (default 30 days, bounded to 1 hour through 365 days) and
`max_rows` (default 256, bounded to 4096) so callers can schedule small maintenance passes
without creating a broad deletion path.

`AuthService` owns the production trigger. After startup initialization and config load, it
runs one fail-safe maintenance pass through the message bus using
`DB.PruneOrphanedMeshPeerRows`; failures are logged and do not stop Auth startup. The pass is
controlled by:

- `services.auth.mesh_peer_orphan_pruning_enabled` (default `true`)
- `services.auth.mesh_peer_orphan_retention_seconds` (default `2592000`)
- `services.auth.mesh_peer_orphan_prune_max_rows` (default `256`)

The DB manager first selects eligible rows, then deletes each row by exact `mesh_peers.id`
while re-checking the full eligibility predicate inside the same transaction. It never matches
or deletes by `node_name`, never calls the admin removal/tombstone path, and never mutates
`mesh_peer_auth_grant_revisions`.

The operation is intentionally conservative: it removes only rows with `outbound_status =
'pending'`, `inbound_status IN ('unknown', 'pending')`, no outbound/inbound credential identity
fields, no approval timestamps or approver markers, empty outbound/inbound permission arrays,
and an age older than the retention window based on `COALESCE(last_seen_at, first_seen_at)`.
Anything approved, denied, fresh, permission-bearing, approval-marked, or credential-linked
survives for explicit user review.

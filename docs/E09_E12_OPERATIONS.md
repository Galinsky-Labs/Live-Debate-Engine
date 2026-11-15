# E-09 to E-12: event operation streams and pre-event workflows

## Architecture (shared by E-09 onward)

Each event workflow is an **operation stream**: a typed, deterministic reducer in `packages/competition/src/operations/` applied to the latest immutable snapshot of one entity, then appended to the shared `lde.revisions` ledger (`kind='operation'`).

- `lde_competition.save_operation` (migration 0012) re-authorizes the command's fixed access action through `lde_competition.authorize` (session, membership, role grant, MFA freshness), checks the `(stream, action)` pair against the `operation_streams` allow-list, enforces the expected revision, binds the entity to one stream, and records command replay and audit rows. Replays bind the caller's command digest, so an exact retry returns the original result.
- `operation_records` serves list/history only to the stream's read action. Callers who may write but not read (self-service) receive a per-stream filtered `view` of only their own record.
- HTTP: `GET|POST /api/tenants/{tenant}/events/{event}/operations/{stream}[/{entity}]`; POST body `{commandId, expectedRevision, type, payload}`; `GET ...?self=participant.self` for the filtered view.
- States are integer-only canonical JSON and bounded by the 128 KiB revision limit (documented per-stream caps).

New access actions: `participant.self` (event roles acting on their own record; ownership-bound) and `floor.participate` (debaters, used from E-14).

## Units

| Unit | Stream | Implemented |
|---|---|---|
| E-09 casting, teams, rosters, judge assignments | `roster` | Teams per side (1-8 members, no member on two teams), role assignments, judge seat count, declared conflicts of interest; lock requires both sides, cast members, enough judges, a moderator and no judge conflict/debater overlap; unlock requires an amendment reason. |
| E-10 eligibility, releases, legal acceptance | `eligibility` | Versioned legal documents (terms/release/privacy/rules) with SHA-256; acceptance must match the exact current revision+hash, and a new revision silently invalidates older acceptances; attestation requirements; organizer review (no self-review); participants see only their own record. |
| E-11 scheduling, production prep, communications | `schedule` | Time zone, run-of-show items with chronology rules, cross-event resource clash detection, production checklist with completion attribution, message drafts/approval with an allow-listed template renderer. Delivery is through a `Notifier` interface; the default is disabled (no provider configured). |
| E-12 audience recruitment, registration, admission | `admission` | Capacity, first-come or published-seed lottery ordering, self-registration/cancellation, deterministic allocation, automatic waitlist promotion, organizer revocation and check-in; registrants see only their own status and waitlist position. |

The partial drafts in PRs #19-#22 were superseded: their roster validation, document-hash acceptance, resource-conflict and queue-ordering ideas are carried into these typed, persisted streams.

## Limits and follow-up

- Message delivery and identity-document verification (ID checks) need providers that are not configured.
- Admission check-in is staff-confirmed; signed ticket QR codes are follow-up work.
- Large public events (>600 registrations per admission entity) need sharding across entities.

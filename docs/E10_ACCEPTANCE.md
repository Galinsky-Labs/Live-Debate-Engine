# E-10 legal-document acceptance preflight

The pure E-10 boundary binds a participant and tenant to an exact immutable
document revision, digest, and canonical timestamp. Changed legal terms require
new acceptance evidence. This function does not verify the identity, legal
capacity or signature of the participant and never opens registration.

Remaining: authenticated eligibility and guardian flows, tamper-evident
acceptance storage, release version history, private personal data retention,
age/jurisdiction rules, integrated organizer and attendee journeys and tests.
No legal conclusion or production readiness is asserted.

## Event-scoped preflight, not consent issuance

`event-acceptance.mjs` now compares a strict event/tenant/participant-scoped set of document receipts to the *exact* required revision and content digest. It rejects foreign-event receipts, foreign-tenant receipts, duplicate document IDs, forged extra fields and missing or superseded evidence. The result always includes `competitionReady:false`, `identityVerified:false` and `legallyEffective:false`; a matching set of strings never substitutes for authenticated, durable consent.

`legal-template.mjs` parses a bounded document kind, title, body, jurisdiction and revision, and calculates a deterministic SHA-256 digest across the immutable envelope. The proposed approval-state label is *not* proof that legal counsel or the document owner approved the text. The envelope explicitly returns `legallyApproved:false` and `operational:false`. Changes to wording, jurisdiction, revision, or approval state change the digest; prior receipts must not be silently reused.

The two new isolated unit suites are `event-acceptance.test.mjs` and `legal-template.test.mjs`. They test structural matching and negative boundaries only, not a live signer, production browser, legally enforceable signature or a real guardian approval.

## Durable integration prerequisite

The canonical development plan depends on E09 roster/identity preparation. The E09 provisional casting work is not merged, and no authenticated document publisher or participant acceptance ledger is yet connected to the database. Do not create an E10 migration that collides with E09's pending 0012 sequence. After upstream integration, implement a new additive guarded migration and a database-backed immutable ledger with verified server timestamps, idempotent commands, participant-bound consent and guardian evidence; add event-specific retrieval, revocation/supersession, privacy retention and real browser/PG negative tests. No deployment or signature validity is claimed by this document.

## Further isolated verification (2026-10-19)

The E10 branch now also contains strict acceptance intent and immutable consent-history projectors, a fail-closed guardian/employee-family evidence matrix, and a legal template transition validator. The projection accepts only strictly increasing ledger sequence with canonical nondecreasing timestamps, exact document scope and revision, and an exact-target withdrawal. A new wording/body/jurisdiction change cannot silently reuse the same published legal revision. No helper grants participation or claims a valid signature.

Fourteen synthetic Node.js isolated model tests passed with mirrored source files whose git-blob hashes matched the immutable Boardroom source reads. This is targeted development evidence, **not** an observed pass for the repository's latest GitHub Actions, PostgreSQL migration, actual browser, or legal review. The exhaustive security/transaction and privacy acceptance matrix remains in `docs/E10_DURABLE_LEDGER_DESIGN.md`. The release ledger and authenticated server endpoints remain unimplemented until dependencies are reconciled. Keep PR20 draft.

## Consent history and receipt validation repair (2026-11-01)

Withdrawal now clears active consent while retaining the highest observed document revision and its digest. A subsequent explicit acceptance may renew the same exact revision or accept a newer one, but cannot roll back to older wording or replace a revision's digest. Active duplicate consent remains rejected. Receipt identifiers and hashes require actual strings; coercible arrays, numbers and objects fail closed. Canonical UTC millisecond timestamps are consistent with the history projector, and revision bounds match the template and command parsers.

Focused model regression tests cover withdrawal/renewal/rollback, digest substitution, identifier coercion, invalid date normalization and canonical milliseconds. These changes do not issue durable receipts or establish signer identity, legal enforceability or participation authority. The prerequisite and integration work above remains pending.


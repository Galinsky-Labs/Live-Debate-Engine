# E-20 to E-23: secret ballots, polls, outcomes and paper fallback

## E-20 secret-ballot service

- **Credentials by RSA blind signature** (`ballot-crypto.ts`, 2048-bit RSA-FDH with MGF1-SHA-256). An elector authenticates, sends a *blinded* random token to `POST /api/tenants/{t}/events/{e}/ballots/{poll}/issue`, and unblinds the issuer's signature locally. The database records only that the elector received a credential (`ballot_issuance`, one per elector per poll).
- **Anonymous casting**: `POST .../cast` with `{token, signature, round, choice}` and **no session cookie** (requests carrying cookies are refused so a ballot cannot be linked to a session). The application verifies the signature; the database (`ballot_cast`) accepts only the open round, one ballot per credential pseudonym per round, and never more ballots per round than credentials issued.
- Stored ballots hold `sha256(token)` pseudonym, round, choice and a receipt — no voter identity and no cast timestamp. Rows are immutable (update/delete triggers).
- **Verifiability**: each voter receives `receipt = sha256(pseudonym|round|choice)`; after close, `GET .../receipts` publishes the sorted receipt list to event participants.
- The issuer key is generated at electorate lock, stored only sealed (AES-256-GCM, key derived from the server secret, bound to tenant/event/poll), and redacted from every API response.
- Residual risks (documented, not solved here): network-level timing correlation between issuance and casting; a compromised application server could sign extra credentials (bounded by issued count, which is audited per elector); a lost credential cannot be reissued without enabling double voting.

## E-21 poll orchestration and electorate locking

`poll` stream: `lockElectorate` (event manager) stores salted SHA-256 digests of elector principal ids, the count and a list digest, irreversibly; then `open/close` pre and post rounds in order (moderator). Issuance is allowed only while locked or pre-open (late arrivals are spectators, per the ruleset).

## E-22 deterministic outcome calculation

`outcome.ts`: votes form a pre×post transition matrix for the **paired-valid cohort** (voters with valid ballots in both rounds; denominator includes undecided). Because both rounds share the denominator, the side with the larger percentage-point gain is exactly the side with the larger integer gain — no floating point. Empty cohort → `inconclusive` (held for review); equal gains → `tie`; advancement uses the audience result first and the judges on an audience tie (`audienceTie: judges`). Exact rational comparison helper for judge scores. The `results` stream's `computeAudience` reads the tally and reconciled paper counts **inside the verifier's transaction** (callers supply only ids) and records inputs, electorate digest and verdict with an explanation.

## E-23 paper/keypad fallback and reconciliation

`paper` stream: batches are declared with issued stock; two **different** tellers (result verifiers) each enter the batch's paired transition counts and spoiled count; identical entries reconcile the batch, any difference marks it disputed (reset requires a reason). Counts plus spoiled may not exceed stock. Only reconciled batches are combined with the electronic tally.

# E-24 to E-26: judging, rubric aggregation and certification

## E-24 human judging workspace

`panel` stream (event manager): rubric (weights sum to 10000 bps), penalty/virtue caps, aggregation and seated judges, fixed once opened. `scorecard` stream (`scorecard.write-own`): the first writer binds the card; only seated judges may write; the **rubric is loaded server-side from the panel** (a client-supplied `panel` is rejected); drafts may be partial; submission requires every criterion for both sides and seals the card; recusal with reason. Judges see only their own card; verifiers read all cards.

## E-25 rubric, penalties, virtues and aggregation

`judging.ts`: side totals on a 0-100 scale computed with BigInt rationals (`Σ weight·(score−min)/(max−min)`), virtues minus penalties; per-finding and total caps, evidence required, no double counting of the same finding. Panel aggregation `mean`, `sum` or `majority`; fewer submitted cards than seats → `inconclusive` (all seats required).

## E-26 verification, certification, announcement

`results` stream: `computeAudience` and `recordJudges` read the tally/cards server-side; any input change recomputes the advancement decision and a SHA-256 results hash and clears verifications. Certification (`result.publish`) requires two distinct verifiers on the current hash, a certifier who is not one of only two verifiers, and a decisive outcome (inconclusive/tie-without-judges is held for review). Announcement follows certification. `reopen` records an audited correction (reason, previous hash), bumps the results version and requires fresh verification.

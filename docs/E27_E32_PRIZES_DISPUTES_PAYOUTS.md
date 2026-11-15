# E-27 to E-32: prizes, brackets, disputes, payouts and acceptance

Operation streams (migration 0015) on the architecture in [E09_E12_OPERATIONS.md](E09_E12_OPERATIONS.md). All money is exact minor units (decimal strings, BigInt arithmetic) with deterministic largest-remainder apportionment.

| Unit | Implemented |
|---|---|
| E-27 standard-debate prize ledger | `prizes`: funded budget and currency; `allocateStandard` reads **certified** results and the **locked** roster server-side and splits the pool 50/50 between the audience and judges winners (ties split the share between sides; team shares split equally among members); commitments can never exceed budget; every obligation needs two distinct finance approvals and no self-approval; hold/release/forfeit/settle with notes and a commit/release journal. |
| E-28 tournament brackets and advancement | `bracket`: single elimination for 2-64 teams, standard seeding (1 v N), automatic byes, advancement only with a certified results hash, completion detection. |
| E-29 placement prizes and special awards | `placements()` and `placementAwards()`: places by elimination round, tied teams share the summed weights of the places they span; awards recorded on the prize ledger with a basis (`addAwards`). Special awards are organizer-designated with justification (no automated best-speaker metric yet). |
| E-30 disputes, sanctions, disqualification, corrections | `disputes`: filing window, self-service filing (≤3 open), withdrawal, reviewer may not be the filer, upheld decisions must carry a remedy; outcome-changing remedies and disqualifications create `correctionsRequired` entries that are resolved through the audited results `reopen` (E-26) and ledger forfeit/hold (E-27). Filers see only their own disputes and sanctions. |
| E-31 payee onboarding and payout execution | `payouts` with a `PaymentProvider` interface. **No payment keys are configured, so the default provider fails closed** (`payment_provider_unconfigured`); a simulator exists for tests only. Payouts require an approved obligation (read server-side), a verified payee and tax form (recorded by finance, never self-verified), two distinct approvers, idempotent provider submission keyed by payout id, and support documented manual settlement. |
| E-32 acceptance suite | `tests/unit/acceptance-competition.test.mjs` runs one standard debate end to end through every reducer: roster lock, eligibility, admission allocation, electorate lock, real blind-signature credentials, ordered phases and timers, paired pre/post outcome (one voter missing the post vote is excluded), seated judges, double verification and certification, an independently reviewed dispute, the 50/50 prize split and simulated payouts that total the budget exactly. Real-HTTP/PostgreSQL coverage for each stream lives in `tests/integration/operations-cases.mjs`. This is automated acceptance with synthetic data, not a live event with real participants. |

## Owner decisions / keys

- Choose a payment/payout provider (e.g. Stripe Connect) and add its keys before any real payout; tax-form collection (W-8/W-9 or local equivalent) and KYC policy are legal decisions.
- Prize budgets and approvers are operational decisions; nothing here authorizes spending.

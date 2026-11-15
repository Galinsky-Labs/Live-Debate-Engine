# Development progress

Approved: 50 engine steps (E-01..E-50). UBC steps live in Galinsky-Labs/UBC-Debates. Counts are not effort estimates.

| Steps | PR | Status |
|---|---|---|
| E-01..E-07 | #1, #2, #3, #4, #6, #9, #10 | Merged |
| E-08 | #18 (with #12-#14) | Merged |
| E-09..E-12 | #25 | Merged: operation-stream architecture; roster, eligibility, schedule, admission |
| E-13..E-19 | #26 | Merged: state machine, floor/timers, console view models, media (provider disabled), recording, transcript, Q&A |
| E-20..E-26 | #27 | Merged: blind-signature secret ballots, polls, outcome, paper fallback, judging, certification |
| E-27..E-32 | #28 | Merged: prize ledger, brackets, placements, disputes, payouts (provider disabled), acceptance suite |
| E-33, E-37 | #29 | Merged: public catalog API v1, SDK, webhook signing (E-34 partial: distribution package) |
| E-34 (rest), E-35, E-36, E-38..E-50 | none | Not implemented |

Auxiliary: #24 hosted deployment (Render `live-debate-engine` + Neon `live-debate-engine`), #30 tenant bootstrap. Superseded drafts #15, #19-#22 closed.

"Merged" means code and automated tests are on `main` with green CI. It is not operational acceptance: no real event has been run, no independent review has happened, and media, ASR, payment and email providers are not configured.

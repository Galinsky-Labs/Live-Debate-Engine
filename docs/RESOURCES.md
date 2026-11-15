# Project resources

Updated 2026-11-15. These identifiers are resource references, not credentials or proof of application readiness.

| Product | GitHub | Render service | Neon project (org Galinsky Laboratories) |
|---|---|---|---|
| Live Debate Engine | Galinsky-Labs/Live-Debate-Engine | `live-debate-engine` (free, Ohio) | `live-debate-engine` (`rapid-dew-21655901`, aws-us-east-2, PostgreSQL 17) |
| UBC Debates | Galinsky-Labs/UBC-Debates | `ubc-debates` (thin client of the engine) | none required |

Earlier documentation referenced Neon projects `winter-pond-37009599` and `hidden-tree-79062557` and Render projects `prj-db5jt4l9fdbs73d4tgug` / `prj-db5jtaqd0e5s73fo0qkg`. Those resources are not in the Galinsky Laboratories organization and must not be used. The hosted deployment is documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Operational gates

Hosted identity runs with `LDE_IDENTITY_MAIL_MODE=disabled` until the owner supplies a Resend key and verified sending domain, so new accounts cannot verify email yet. Do not treat a live health check as competition readiness. The repositories are public: participant records, tax forms and secrets stay outside them. Account connections are not authorization to spend.

## Engine Room

The `Galinsky-Labs/Engine-Room` integration reads approved `.exechub/project.yml` manifests and real PR records. This engine has 50 approved steps. UBC has separate steps; U steps must not inflate the engine count. PR mappings must come from observed GitHub records.

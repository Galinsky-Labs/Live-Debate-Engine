# E-33 and E-37: public event experience/archive API, SDK and webhooks

## Public API v1 (`/api/public/v1`)

Anonymous, read-only, versioned (`x-api-version: public-v1`; breaking changes require `/v2`). Backed by `lde_competition.public_catalog` (migration 0016), a SECURITY DEFINER function that returns only:

- events whose administration record is **published**, with the exact **published motion revision**;
- the current live phase;
- results **only after announcement** (audience verdict summary, judges decision/scores, advancement, results hash and version);
- transcripts **only after publication**, without principal identifiers.

Endpoints: `GET /api/public/v1/tenants/{tenantId}/events`, `.../events/{eventId}` (includes transcript), `.../events/{eventId}/package` (E-34 distribution package with SHA-256 manifest). Responses are cacheable for 30 s. Browser access from other sites is limited to the exact origins in `LDE_PUBLIC_CORS_ORIGINS` (comma-separated HTTPS origins; GET only, no credentials).

## SDK (`packages/sdk`)

Dependency-free TypeScript client: `PublicClient` (HTTPS-only base URL, `credentials: 'omit'`, redirect refusal, API-version check, typed errors) and `OperationsClient` (same-origin authenticated commands against operation streams). The blind-ballot voter helpers live in `packages/competition/src/operations/ballot-crypto.ts`.

## Webhooks

`signWebhook`/`verifyWebhook` define the outbound signature format (`t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`, 5-minute tolerance, constant-time comparison). Delivery workers and per-tenant subscription management are follow-up work (no outbound delivery is performed yet).

## Engine Room

`.exechub/project.yml` and `registry/prs.json` remain the integration surface; PR mappings are updated per merged unit.

## Not done in this change

E-34 editorial publishing workflow (beyond the distribution package), E-35 access entitlements/memberships/tickets/supporters, and E-36 full white-label configuration (two neutral reference brands exist from E-06) remain open.

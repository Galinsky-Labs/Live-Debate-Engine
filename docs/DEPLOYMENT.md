# Hosted deployment (Render + Neon)

## Resources

- Render web service `live-debate-engine`, free plan, Ohio, auto-deploy from `main`; blueprint record in `render.yaml`.
- Neon project `live-debate-engine` in the Galinsky Laboratories organization, aws-us-east-2, PostgreSQL 17, database `neondb`.

## Build and start

- Build: `npm ci --ignore-scripts --include=dev && npm run build` (dev dependencies are needed for `tsc`/`esbuild`; `NODE_ENV=production` would otherwise omit them).
- Start: `npm run start:hosted`, which runs `dist/scripts/migrate.js` with the owner credential and then starts the API with `LDE_MIGRATION_DATABASE_URL` and `DATABASE_URL_UNPOOLED` removed from the environment. The API also refuses to start with identity enabled if either is present.
- Health check: `/api/health` (liveness). `/api/ready` reports schema compatibility.

## Three database roles on a managed provider

The engine separates the release owner, the competition runtime (`lde_runtime`) and the identity provider (`lde_identity`); SECURITY DEFINER functions are owned by the NOLOGIN `lde_guard` role.

Neon does not grant superuser, and roles created through the Neon API/console are members of `neon_superuser` with CREATEROLE/CREATEDB, which the engine's startup role assertion (`assertDatabaseRole`) rejects. Therefore the login roles are created in SQL by the release step instead of through the Neon API:

1. `prepareManagedOwner` (non-superuser owner only) pre-creates the three NOLOGIN base roles with the attributes migration 0005 asserts, grants them to the owner `WITH INHERIT FALSE, SET TRUE` (PostgreSQL 16+ requires SET membership to transfer function ownership), and for the migration window grants `CREATE` on the engine schemas to `lde_guard` (also required for ownership transfer by a non-superuser).
2. Migrations apply under the existing advisory lock and checksum history.
3. `finishManagedOwner` revokes the migration-window `CREATE` grants (also on failure).
4. With `LDE_PROVISION_LOGIN_ROLES=1`, `provisionLoginRoles` creates or rotates the dedicated login roles named in `DATABASE_URL` (`lde_app` → `lde_runtime`) and `LDE_IDENTITY_DATABASE_URL` (`lde_auth` → `lde_identity`) from their passwords, refuses roles with unsafe attributes and revokes cross-membership.

The owner must have BYPASSRLS (Neon's `neondb_owner` does) because engine tables use `FORCE ROW LEVEL SECURITY` and seed rows during migration.

This flow was exercised against a local PostgreSQL 16 cluster with a non-superuser CREATEROLE+BYPASSRLS owner: 11 migrations applied, both login roles provisioned, `/api/ready` returned `schema_compatible`, sign-up succeeded, and the verification mail was suppressed.

## Environment variables

| Key | Source | Notes |
|---|---|---|
| `LDE_MIGRATION_DATABASE_URL` | Neon owner, direct host, `sslmode=require` | Release step only. |
| `DATABASE_URL` | `lde_app` with generated password, pooled host | Runtime role. |
| `LDE_IDENTITY_DATABASE_URL` | `lde_auth` with generated password, pooled host | Identity role. |
| `LDE_IDENTITY_SECRET` | generated, 64 base64url chars | Never committed. |
| `LDE_IDENTITY_ORIGIN` | `https://live-debate-engine.onrender.com` | Canonical HTTPS origin. |
| `LDE_IDENTITY_MAIL_MODE` | `disabled` until Resend is configured, then `resend` | Disabled mode never delivers or logs links. |
| `RESEND_API_KEY`, `LDE_IDENTITY_MAIL_FROM` | Owner to-do | Needed for email verification and password reset. |

Neon connection strings include `channel_binding=require`; the engine refuses that option (the driver can only prefer channel binding), so the stored URLs use `sslmode=require` only.

import pg from 'pg';
import { databaseConfig } from '../packages/database/src/config.js';
import { finishManagedOwner, loginCredential, prepareManagedOwner, provisionLoginRoles } from '../packages/database/src/managed-roles.js';
import { applyMigrations, loadMigrations } from '../packages/database/src/migrations.js';

let pool: pg.Pool | undefined;
try {
  const env = process.env;
  // LDE_MIGRATION_DATABASE_URL is the release-owner credential used by hosted release steps.
  // The start wrapper removes it before the serving process starts.
  const connection = env.LDE_MIGRATION_DATABASE_URL ?? env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  if (!connection) throw new Error('Database URL required');
  if (env.LDE_PROVISION_LOGIN_ROLES && !['0', '1'].includes(env.LDE_PROVISION_LOGIN_ROLES)) throw new Error('Invalid provisioning flag');
  pool = new pg.Pool(databaseConfig(connection, env));
  pool.on('error', () => console.error(JSON.stringify({ event: 'migration_connection_error' })));
  const owner = await prepareManagedOwner(pool);
  let applied: number;
  try { applied = await applyMigrations(pool, await loadMigrations()); }
  finally { if (owner === 'managed') await finishManagedOwner(pool); }
  console.log(JSON.stringify({ event: 'migrations_applied', count: applied, owner }));
  // Optional idempotent tenant bootstrap for hosted deployments (e.g. the UBC Debates tenant).
  const tenants = (env.LDE_BOOTSTRAP_TENANT_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (tenants.length > 10 || tenants.some((value) => !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))) throw new Error('Invalid tenant bootstrap list');
  for (const tenant of tenants) await pool.query('INSERT INTO lde.tenants(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [tenant]);
  if (tenants.length) console.log(JSON.stringify({ event: 'tenants_bootstrapped', count: tenants.length }));
  if (env.LDE_PROVISION_LOGIN_ROLES === '1') {
    if (!env.DATABASE_URL || !env.LDE_IDENTITY_DATABASE_URL) throw new Error('Runtime and identity URLs required');
    const provisioned = await provisionLoginRoles(pool, [
      loginCredential(env.DATABASE_URL, 'lde_runtime'),
      loginCredential(env.LDE_IDENTITY_DATABASE_URL, 'lde_identity'),
    ]);
    console.log(JSON.stringify({ event: 'login_roles_provisioned', count: provisioned }));
  }
} catch {
  console.error(JSON.stringify({ event: 'migration_failed', hint: 'Check approved target, credentials, manifest and database availability; no automatic destructive rollback' }));
  process.exitCode = 1;
} finally { await pool?.end(); }

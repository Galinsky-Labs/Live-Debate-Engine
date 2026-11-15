import type { Pool } from 'pg';

/** Base roles created by migration 0005; they never log in and own no data themselves. */
export const BASE_ROLES = Object.freeze(['lde_runtime', 'lde_identity', 'lde_guard'] as const);
export type LoginCredential = Readonly<{ username: string; password: string; base: 'lde_runtime' | 'lde_identity' }>;

/**
 * Managed PostgreSQL providers (for example Neon) give the release owner CREATEROLE without
 * superuser. PostgreSQL 16+ then requires explicit SET membership before the owner may assign
 * function ownership to lde_guard. Pre-create the exact base roles with the same safe attributes
 * migration 0005 asserts, and grant SET (not INHERIT) to the release owner only.
 */
export async function prepareManagedOwner(pool: Pool): Promise<'superuser' | 'managed'> {
  const client = await pool.connect();
  try {
    const owner = await client.query<{ rolsuper: boolean; rolcreaterole: boolean }>('SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname=current_user');
    const row = owner.rows[0];
    if (!row) throw new Error('Unknown migration role');
    if (row.rolsuper) return 'superuser';
    if (!row.rolcreaterole) throw new Error('Migration owner requires CREATEROLE on a managed provider');
    await client.query('BEGIN');
    try {
      for (const role of BASE_ROLES) {
        const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
        if (exists.rowCount === 0) {
          const create = await client.query<{ sql: string }>("SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',$1::text) AS sql", [role]);
          await client.query(create.rows[0]?.sql ?? '');
        }
        const grant = await client.query<{ sql: string }>('SELECT format(\'GRANT %I TO %I WITH INHERIT FALSE, SET TRUE\',$1::text,current_user::text) AS sql', [role]);
        await client.query(grant.rows[0]?.sql ?? '');
      }
      // ALTER ... OWNER TO lde_guard also requires CREATE on the target schema for non-superusers.
      // Grant it only for the migration window (including schemas a migration creates) and
      // revoke it again in finishManagedOwner.
      await client.query('ALTER DEFAULT PRIVILEGES GRANT CREATE ON SCHEMAS TO lde_guard');
      for (const schema of await ownedSchemas(client)) {
        const sql = await client.query<{ sql: string }>("SELECT format('GRANT CREATE ON SCHEMA %I TO lde_guard',$1::text) AS sql", [schema]);
        await client.query(sql.rows[0]?.sql ?? '');
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    return 'managed';
  } finally { client.release(); }
}

async function ownedSchemas(client: import('pg').PoolClient): Promise<string[]> {
  const result = await client.query<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE pg_has_role(current_user,nspowner,'USAGE') AND (nspname LIKE 'lde%' OR nspname='engine_meta') ORDER BY nspname");
  return result.rows.map((row) => row.nspname);
}

/** Remove the migration-window CREATE grants from lde_guard (idempotent). */
export async function finishManagedOwner(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('ALTER DEFAULT PRIVILEGES REVOKE CREATE ON SCHEMAS FROM lde_guard');
      for (const schema of await ownedSchemas(client)) {
        const sql = await client.query<{ sql: string }>("SELECT format('REVOKE CREATE ON SCHEMA %I FROM lde_guard',$1::text) AS sql", [schema]);
        await client.query(sql.rows[0]?.sql ?? '');
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  } finally { client.release(); }
}

/** Parse a runtime/identity connection URL into a login credential without logging it. */
export function loginCredential(connection: string, base: LoginCredential['base']): LoginCredential {
  let url: URL;
  try { url = new URL(connection); } catch { throw new Error('Invalid login credential URL'); }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!/^lde_[a-z0-9_]{2,40}$/.test(username) || ['lde_runtime', 'lde_identity', 'lde_guard'].includes(username)) throw new Error('Login role must be a dedicated lde_* role');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new Error('Login role password must be a high-entropy token');
  return Object.freeze({ username, password, base });
}

/**
 * Create or rotate the dedicated non-owner login roles and grant only their base role.
 * Runs as the release owner after migrations; the serving process never receives that owner.
 */
export async function provisionLoginRoles(pool: Pool, credentials: readonly LoginCredential[]): Promise<number> {
  if (credentials.length === 0 || new Set(credentials.map((item) => item.username)).size !== credentials.length) throw new Error('Distinct login roles required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      for (const credential of credentials) {
        const existing = await client.query<{ unsafe: boolean }>('SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname=$1', [credential.username]);
        const statement = existing.rowCount === 0
          ? "SELECT format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql"
          : "SELECT format('ALTER ROLE %I WITH LOGIN INHERIT PASSWORD %L',$1::text,$2::text) AS sql";
        if (existing.rows[0]?.unsafe) throw new Error('Existing login role has unsafe attributes');
        const sql = await client.query<{ sql: string }>(statement, [credential.username, credential.password]);
        await client.query(sql.rows[0]?.sql ?? '');
        const other = credential.base === 'lde_runtime' ? 'lde_identity' : 'lde_runtime';
        for (const revoke of [other, 'lde_guard']) {
          const r = await client.query<{ sql: string }>("SELECT format('REVOKE %I FROM %I',$1::text,$2::text) AS sql", [revoke, credential.username]);
          await client.query(r.rows[0]?.sql ?? '');
        }
        const grant = await client.query<{ sql: string }>("SELECT format('GRANT %I TO %I',$1::text,$2::text) AS sql", [credential.base, credential.username]);
        await client.query(grant.rows[0]?.sql ?? '');
        const connect = await client.query<{ sql: string }>("SELECT format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),$1::text) AS sql", [credential.username]);
        await client.query(connect.rows[0]?.sql ?? '');
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    return credentials.length;
  } finally { client.release(); }
}

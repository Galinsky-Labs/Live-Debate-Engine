import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { withCredential, AccessError } from '../../identity/src/broker.js';
import type { IdentityRuntime } from '../../identity/src/http.js';
import { HttpError, readJson } from '../../competition/src/http.js';
import { sealPrivateKey } from '../../competition/src/operations/ballot-crypto.js';
import { BrandError, parseBrand } from './branding.js';
import { WEBHOOK_SECRET_CONTEXT } from './webhooks.js';

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const ROUTE = new RegExp(`^/api/tenants/${ID}/(branding|webhooks)(?:/${ID})?$`);
const KIND = /^(\*|[a-z-]{2,40}|operation:[a-z-]{2,40})$/;
export type TenantHttpRuntime = Readonly<{ handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> }>;
/** Tenant administration: white-label configuration (E-36) and webhook subscriptions (E-37). */
export function createTenantHttp(pool: Pool, identity: IdentityRuntime, origin: string, secret: string): TenantHttpRuntime {
  return Object.freeze({ handle: async (request, response) => {
    let url: URL; try { url = new URL(request.url ?? '/', origin); } catch { return false; }
    const route = ROUTE.exec(url.pathname); if (!route) return false;
    const [, tenant = '', resource, item] = route;
    const send = (status: number, value: unknown) => { const body = JSON.stringify(value); response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) }); response.end(body); };
    try {
      if (!['GET', 'POST'].includes(request.method ?? '')) throw new HttpError(405, 'method_not_allowed');
      if (request.method === 'POST' && (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site')) throw new HttpError(403, 'origin_denied');
      if (url.search) throw new HttpError(400, 'invalid_request');
      const actor = await identity.authenticate(request);
      const result = await withCredential(pool, actor.token, async (client) => {
        if (resource === 'branding') {
          if (request.method === 'GET') return (await client.query('SELECT lde_competition.public_branding($1) AS result', [tenant])).rows[0]?.result ?? { brand: null, revision: 0 };
          const body = await readJson(request) as { expectedRevision?: unknown; brand?: unknown };
          if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'brand,expectedRevision' || !Number.isSafeInteger(body.expectedRevision)) throw new HttpError(400, 'invalid_request');
          return (await client.query('SELECT lde_competition.save_branding($1,$2,$3) AS result', [tenant, body.expectedRevision, JSON.stringify(parseBrand(body.brand))])).rows[0]?.result;
        }
        if (request.method === 'GET') return { webhooks: (await client.query('SELECT lde_competition.list_webhooks($1) AS result', [tenant])).rows[0]?.result };
        if (!item) throw new HttpError(400, 'invalid_request');
        const body = await readJson(request) as { url?: unknown; kinds?: unknown; active?: unknown; rotateSecret?: unknown };
        if (!body || typeof body !== 'object' || Object.keys(body).sort().join() !== 'active,kinds,rotateSecret,url') throw new HttpError(400, 'invalid_request');
        const target = typeof body.url === 'string' ? new URL(body.url) : null;
        if (!target || target.protocol !== 'https:' || target.username || target.password || target.hash || target.href.length > 500) throw new HttpError(400, 'invalid_webhook_url');
        if (!Array.isArray(body.kinds) || body.kinds.length < 1 || body.kinds.length > 20 || body.kinds.some((k) => typeof k !== 'string' || !KIND.test(k))) throw new HttpError(400, 'invalid_kinds');
        if (typeof body.active !== 'boolean' || typeof body.rotateSecret !== 'boolean') throw new HttpError(400, 'invalid_request');
        // The signing secret is shown once, on creation or rotation, and stored only sealed.
        const plain = body.rotateSecret ? randomBytes(32).toString('base64url') : null;
        const saved = (await client.query('SELECT lde_competition.save_webhook($1,$2,$3,$4,$5,$6) AS result', [tenant, item, target.href, body.kinds, plain ? sealPrivateKey(plain, secret, WEBHOOK_SECRET_CONTEXT(item)) : '', body.active])).rows[0]?.result;
        return { ...saved, ...(plain ? { signingSecret: plain } : {}) };
      });
      send(200, result);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (error instanceof HttpError) send(error.status, { error: error.code });
      else if (error instanceof BrandError) send(400, { error: error.code });
      else if (error instanceof AccessError && error.status === 401) send(401, { error: 'authentication_required' });
      else if (error instanceof AccessError || code === '42501') send(404, { error: 'tenant_unavailable' });
      else if (code === '40001') send(409, { error: 'revision_conflict' });
      else if (code === '54000') send(413, { error: 'limit_exceeded' });
      else if (['22023', '23514', '22P02'].includes(code)) send(400, { error: 'invalid_request' });
      else send(503, { error: 'tenant_unavailable', ref: randomUUID() });
    }
    return true;
  } });
}

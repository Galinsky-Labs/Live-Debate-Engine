import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';

/** E-37 versioned public API. Stable, anonymous, read-only; breaking changes require /v2. */
export const PUBLIC_API_VERSION = 'public-v1';
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const EVENTS = new RegExp(`^/api/public/v1/tenants/${ID}/events(?:/${ID}(/package)?)?$`);
const BRAND = new RegExp(`^/api/public/v1/tenants/${ID}/brand$`);

/** Parse an allow-list of exact HTTPS origins permitted to read the public API from browsers. */
export function corsOrigins(value: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const raw of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const url = new URL(raw);
    if (url.origin !== raw || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Invalid public CORS origin');
    origins.add(raw);
  }
  return origins;
}
/** E-34 distribution package: canonical JSON body plus a SHA-256 manifest for syndication partners. */
export function distributionPackage(event: Record<string, unknown>, generatedAt: string) {
  const body = JSON.stringify({ apiVersion: PUBLIC_API_VERSION, generatedAt, event });
  return { manifest: { apiVersion: PUBLIC_API_VERSION, generatedAt, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) }, body: JSON.parse(body) as unknown };
}
/** Outbound webhook signature (E-37): `t=<unix>,v1=<hex hmac-sha256(secret, t.body)>`. */
export function signWebhook(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex')}`;
}
export function verifyWebhook(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header); if (!match) return false;
  const t = Number(match[1]); if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, body, t).slice(-64), 'hex');
  return timingSafeEqual(expected, Buffer.from(match[2] ?? '', 'hex'));
}

export type PublicHttpRuntime = Readonly<{ handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> }>;
export function createPublicHttp(pool: Pool, allowedOrigins: ReadonlySet<string>, clock: () => number = Date.now): PublicHttpRuntime {
  return Object.freeze({ handle: async (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (!path.startsWith('/api/public/')) return false;
    const origin = typeof request.headers.origin === 'string' && allowedOrigins.has(request.headers.origin) ? request.headers.origin : null;
    const send = (status: number, value: unknown, cache = 'public, max-age=30') => {
      const body = JSON.stringify(value);
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': status === 200 ? cache : 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'content-length': Buffer.byteLength(body), 'x-request-id': randomUUID(),
        'x-api-version': PUBLIC_API_VERSION, vary: 'Origin', ...(origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET', 'access-control-max-age': '600' } : {}) });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      if (request.method === 'OPTIONS') { response.writeHead(origin ? 204 : 403, { vary: 'Origin', ...(origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'accept', 'access-control-max-age': '600' } : {}) }); response.end(); return true; }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { send(405, { error: 'method_not_allowed' }); return true; }
      // Public reads never use cookies or credentials.
      if (path === '/api/public/v1') { send(200, { apiVersion: PUBLIC_API_VERSION, resources: ['/api/public/v1/tenants/{tenantId}/brand', '/api/public/v1/tenants/{tenantId}/events', '/api/public/v1/tenants/{tenantId}/events/{eventId}', '/api/public/v1/tenants/{tenantId}/events/{eventId}/package'] }); return true; }
      const brand = BRAND.exec(path);
      if (brand) {
        const row = (await pool.query<{ result: unknown }>('SELECT lde_competition.public_branding($1) AS result', [brand[1]])).rows[0]?.result;
        if (!row) send(404, { error: 'not_found' }); else send(200, row, 'public, max-age=300');
        return true;
      }
      const route = EVENTS.exec(path);
      if (!route) { send(404, { error: 'not_found' }); return true; }
      const [, tenant, event, pkg] = route;
      const result = (await pool.query<{ result: { events: Record<string, unknown>[] } }>('SELECT lde_competition.public_catalog($1,$2) AS result', [tenant, event ?? null])).rows[0]?.result;
      if (!event) { send(200, result); return true; }
      const listed = result?.events[0];
      if (!listed) { send(404, { error: 'not_found' }); return true; }
      const editorial = (await pool.query<{ result: unknown }>('SELECT lde_competition.public_editorial($1,$2) AS result', [tenant, event])).rows[0]?.result ?? [];
      const found = { ...listed, editorial };
      send(200, pkg ? distributionPackage(found, new Date(clock()).toISOString()) : { apiVersion: PUBLIC_API_VERSION, event: found });
    } catch { send(503, { error: 'public_api_unavailable' }); }
    return true;
  } });
}

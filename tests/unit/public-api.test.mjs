import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { corsOrigins, distributionPackage, signWebhook, verifyWebhook, createPublicHttp } from '../../dist/packages/public/src/http.js';
import { PublicClient, EngineApiError } from '../../dist/packages/sdk/src/index.js';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('CORS allow-list accepts only exact HTTPS origins', () => {
  assert.deepEqual([...corsOrigins('https://ubc-debates.onrender.com, http://localhost:8000')], ['https://ubc-debates.onrender.com', 'http://localhost:8000']);
  for (const bad of ['http://evil.example', 'https://a.example/path', '*']) assert.throws(() => corsOrigins(bad));
});
test('webhook signatures verify, expire and reject tampering', () => {
  const secret = 'w'.repeat(32); const body = '{"type":"results.announced"}'; const header = signWebhook(secret, body, 1700000000);
  assert.equal(verifyWebhook(secret, body, header, 1700000100), true);
  assert.equal(verifyWebhook(secret, body + ' ', header, 1700000100), false);
  assert.equal(verifyWebhook(secret, body, header, 1700001000), false);
  assert.equal(verifyWebhook('x'.repeat(32), body, header, 1700000100), false);
});
test('distribution package manifest hashes the exact body', () => {
  const pkg = distributionPackage({ eventId: 'e', title: 'T' }, '2027-01-01T00:00:00.000Z');
  assert.equal(pkg.manifest.bytes, JSON.stringify(pkg.body).length); assert.match(pkg.manifest.sha256, /^[a-f0-9]{64}$/);
});
test('public HTTP is read-only, versioned and CORS-scoped; SDK validates versions', async () => {
  const tenant = randomUUID(); const event = { eventId: randomUUID(), title: 'Public debate' };
  const pool = { query: async (sql, [t, e]) => (sql.includes('public_editorial') ? { rows: [{ result: [] }] } : { rows: [{ result: { apiVersion: 'public-v1', tenantId: t, events: e && e !== event.eventId ? [] : [event] } }] }) };
  const server = createServer(async (req, res) => { if (!(await createPublicHttp(pool, corsOrigins('https://ubc.example')).handle(req, res))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const listed = await fetch(`${base}/api/public/v1/tenants/${tenant}/events`, { headers: { origin: 'https://ubc.example' } });
    assert.equal(listed.headers.get('access-control-allow-origin'), 'https://ubc.example'); assert.equal(listed.headers.get('x-api-version'), 'public-v1');
    const other = await fetch(`${base}/api/public/v1/tenants/${tenant}/events`, { headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${base}/api/public/v1/tenants/${tenant}/events`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/public/v1/tenants/not-a-uuid/events`)).status, 404);
    const client = new PublicClient(base);
    assert.equal((await client.listEvents(tenant))[0].title, 'Public debate');
    assert.equal((await client.getEvent(tenant, event.eventId)).eventId, event.eventId);
    await assert.rejects(client.getEvent(tenant, randomUUID()), (e) => e instanceof EngineApiError && e.status === 404);
    assert.match((await client.getPackage(tenant, event.eventId)).manifest.sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => new PublicClient('http://engine.example'), /HTTPS/);
  } finally { server.close(); }
});

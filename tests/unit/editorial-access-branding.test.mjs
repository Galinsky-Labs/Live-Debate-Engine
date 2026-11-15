import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyCommand } from '../../dist/packages/competition/src/operations/stream.js';
import { editorialStream, visibleArticles } from '../../dist/packages/competition/src/operations/editorial.js';
import { createAccessStream, disabledCheckoutProvider, simulatedCheckoutProvider, hasEntitlement } from '../../dist/packages/competition/src/operations/access.js';
import { parseBrand, contrast, brandCss } from '../../dist/packages/public/src/branding.js';
import { privateAddress, WebhookWorker, WEBHOOK_SECRET_CONTEXT } from '../../dist/packages/public/src/webhooks.js';
import { verifyWebhook } from '../../dist/packages/public/src/http.js';
import { sealPrivateKey } from '../../dist/packages/competition/src/operations/ballot-crypto.js';

const scope = { tenantId: randomUUID(), eventId: randomUUID(), entityId: randomUUID() };
const ctx = (actor, n = 0) => ({ actor, now: new Date(Date.UTC(2027, 4, 1, 9, n)).toISOString(), scope });
const go = (s, st, type, p, actor, n) => applyCommand(s, st, type, p, ctx(actor, n)).state;

test('E-34 editorial: author drafts, a different editor approves, embargoed publication, withdrawal', () => {
  const [author, editor] = [randomUUID(), randomUUID()]; const id = randomUUID();
  let s = go(editorialStream, editorialStream.initial(scope), 'draft', { articleId: id, kind: 'summary', headline: 'Audience swings for the motion', body: 'A close debate on urban transport ended with a clear swing.', channels: ['public-site', 'newsletter'] }, author, 0);
  s = go(editorialStream, s, 'submit', { articleId: id }, author, 1);
  assert.throws(() => go(editorialStream, s, 'approve', { articleId: id, note: 'ok' }, author, 2), /author_cannot_review/);
  s = go(editorialStream, s, 'approve', { articleId: id, note: 'Facts checked' }, editor, 2);
  assert.throws(() => go(editorialStream, s, 'draft', { articleId: id, kind: 'summary', headline: 'Changed after approval', body: 'Silent edit after approval should be refused.', channels: ['public-site'] }, author, 3), /article_locked/);
  s = go(editorialStream, s, 'publish', { articleId: id, publishAt: ctx(editor, 30).now }, editor, 3);
  assert.equal(visibleArticles(s, ctx(editor, 10).now).length, 0); assert.equal(visibleArticles(s, ctx(editor, 31).now).length, 1);
  s = go(editorialStream, s, 'withdraw', { articleId: id, reason: 'Result reopened after dispute' }, editor, 40);
  assert.equal(visibleArticles(s, ctx(editor, 50).now).length, 0); assert.equal(s.articles[0].history.length, 5);
});

test('E-35 access: free claims, complimentary grants, capacity, payment provider fail-closed, simulator checkout', async () => {
  const [org, fan, fan2] = [randomUUID(), randomUUID(), randomUUID()]; const free = randomUUID(); const paid = randomUUID();
  const disabled = createAccessStream(disabledCheckoutProvider);
  let s = go(disabled, disabled.initial(scope), 'setTier', { tierId: free, kind: 'ticket', name: 'General admission', currency: 'CAD', price: '0', capacity: 1, benefits: ['Seat'], active: true }, org);
  s = go(disabled, s, 'setTier', { tierId: paid, kind: 'supporter', name: 'Supporter', currency: 'CAD', price: '2500', capacity: null, benefits: ['Name in programme'], active: true }, org);
  const claim = async (stream, state, tierId, actor) => applyCommand(stream, state, 'claim', await stream.prepare('claim', { grantId: randomUUID(), tierId }, state, ctx(actor)), ctx(actor)).state;
  s = await claim(disabled, s, free, fan);
  assert.equal(hasEntitlement(s, fan, 'ticket'), true);
  await assert.rejects(claim(disabled, s, free, fan2), /sold_out/);
  await assert.rejects(claim(disabled, s, paid, fan), /payment_provider_unconfigured/);
  s = go(disabled, s, 'grantComplimentary', { grantId: randomUUID(), tierId: paid, principalId: fan2 }, org);
  assert.equal(hasEntitlement(s, fan2, 'supporter'), true);
  const sim = createAccessStream(simulatedCheckoutProvider());
  let p = await claim(sim, s, paid, fan);
  const pending = p.grants.find((g) => g.principalId === fan && g.tierId === paid);
  assert.equal(pending.status, 'pending-payment'); assert.equal(hasEntitlement(p, fan, 'supporter'), false);
  p = go(sim, p, 'confirmPayment', { grantId: pending.grantId, providerEventRef: 'evt_sim_1' }, org);
  assert.equal(hasEntitlement(p, fan, 'supporter'), true);
  assert.throws(() => go(sim, p, 'setTier', { tierId: paid, kind: 'supporter', name: 'Supporter', currency: 'CAD', price: '3000', capacity: null, benefits: [], active: true }, org), /price_locked/);
  assert.equal(sim.view(p, fan).grants.length, 2); assert.equal('capacity' in sim.view(p, fan).tiers[0], false);
});

const brand = { name: 'UBC Debates', shortName: 'UBC', tagline: 'Ideas deserve a hearing', locale: 'en-CA', supportEmail: 'debates@example.org',
  colors: { background: '#ffffff', text: '#152c43', primary: '#174f79', accent: '#a17c31' }, typography: 'serif', customDomains: ['debates.example.org'], footer: 'Example footer', features: { audienceQuestions: true, publicResults: true, transcripts: true } };
test('E-36 white-label: validated config, WCAG contrast enforcement, CSS tokens only from validated colors', () => {
  assert.equal(parseBrand(brand).colors.primary, '#174f79');
  assert.ok(contrast('#000000', '#ffffff') > 20);
  assert.throws(() => parseBrand({ ...brand, colors: { ...brand.colors, text: '#dddddd' } }), /text_contrast/);
  assert.throws(() => parseBrand({ ...brand, colors: { ...brand.colors, primary: 'red;}' } }), /invalid_color/);
  assert.throws(() => parseBrand({ ...brand, name: '<script>' }), /invalid_name/);
  assert.throws(() => parseBrand({ ...brand, customDomains: ['http://x'] }), /invalid_domain/);
  assert.throws(() => parseBrand({ ...brand, extra: 1 }), /invalid_brand/);
  assert.match(brandCss(parseBrand(brand)), /--brand-primary:#174f79/);
});

test('webhooks: SSRF guard, signed delivery, retry acknowledgement', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress('93.184.216.34'), false);
  const secret = 's'.repeat(64); const subscriptionId = randomUUID(); const signing = 'k'.repeat(43);
  const item = { id: 7, attempt: 1, url: 'https://hooks.example.com/lde', sealedSecret: sealPrivateKey(signing, secret, WEBHOOK_SECRET_CONTEXT(subscriptionId)), subscriptionId, payload: { type: 'snapshot.appended' } };
  const acks = []; const sent = [];
  const pool = { query: async (sql, values) => sql.includes('webhook_claim') ? { rows: [{ result: [item, { ...item, id: 8, url: 'https://internal.example.com/' }] }] } : (acks.push(values), { rows: [] }) };
  const fetcher = async (url, init) => { sent.push({ url, init }); return { status: 204, body: null }; };
  const resolver = async (host) => (host === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34']);
  const worker = new WebhookWorker(pool, secret, fetcher, resolver, () => 1700000000000);
  assert.equal(await worker.tick(), 2);
  assert.equal(sent.length, 1); assert.equal(sent[0].init.redirect, 'manual');
  assert.equal(verifyWebhook(signing, sent[0].init.body, sent[0].init.headers['x-lde-signature'], 1700000000), true);
  assert.deepEqual(acks, [[7, true, 204], [8, false, 0]]);
});

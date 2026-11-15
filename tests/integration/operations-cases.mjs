import assert from 'node:assert/strict';
import { administerAccess } from '../../dist/packages/identity/src/administration.js';
import { randomUUID } from 'node:crypto';
import { withCredential } from '../../dist/packages/identity/src/broker.js';
import { blind, unblind } from '../../dist/packages/competition/src/operations/ballot-crypto.js';
import { WebhookWorker } from '../../dist/packages/public/src/webhooks.js';
import { verifyWebhook } from '../../dist/packages/public/src/http.js';

/** E09+ operation streams through real HTTP, provider sessions and database authorization. */
export async function runOperationsCases(t, { x, appPool, admin }) {
  const { f, organizer, a, b, outsider } = x;
  const base = `/api/tenants/${f.tenantId}/events/${f.eventId}/operations`;
  const post = (u, stream, entity, type, payload, expectedRevision, commandId = randomUUID()) => u.client.call(`${base}/${stream}/${entity}`, { method: 'POST', body: { commandId, expectedRevision, type, payload } });

  await t.test('roster commands are organizer-only, revisioned, replayable and audited', async () => {
    const roster = randomUUID(); const team = randomUUID();
    const first = await post(organizer, 'roster', roster, 'setTeam', { teamId: team, name: 'Proposition', side: 'for', members: [a.principalId] }, 0);
    assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.current.snapshot.revision, 1);
    assert.equal(first.data.current.snapshot.data.updatedBy, organizer.principalId);
    const commandId = randomUUID();
    const assigned = await post(organizer, 'roster', roster, 'assign', { principalId: a.principalId, role: 'debater', teamId: team }, 1, commandId);
    assert.equal(assigned.status, 200);
    const replay = await post(organizer, 'roster', roster, 'assign', { principalId: a.principalId, role: 'debater', teamId: team }, 1, commandId);
    assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.data.current.snapshot.revision, 2);
    assert.equal((await post(organizer, 'roster', roster, 'assign', { principalId: b.principalId, role: 'judge', teamId: null }, 1)).status, 409);
    assert.equal((await post(organizer, 'roster', roster, 'lock', { confirm: true }, 2)).status, 422);
    assert.equal((await post(a, 'roster', roster, 'assign', { principalId: b.principalId, role: 'judge', teamId: null }, 2)).status, 404);
    assert.equal((await post(organizer, 'roster', roster, 'drop', {}, 2)).status, 400);
    const read = await a.client.call(`${base}/roster`);
    assert.equal(read.status, 200); assert.equal(read.data.records[0].snapshot.data.state.teams[0].teamId, team);
    const history = await organizer.client.call(`${base}/roster/${roster}`);
    assert.deepEqual(history.data.records.map((r) => r.snapshot.revision), [2, 1]);
    const audit = await admin.query("SELECT count(*)::int AS n FROM lde_competition.audit WHERE tenant_id=$1 AND operation='operation-roster'", [f.tenantId]);
    assert.equal(audit.rows[0].n, 2);
    // Another stream cannot hijack the roster entity.
    assert.equal((await post(organizer, 'schedule', roster, 'setTimeZone', { timeZone: 'UTC' }, 2)).status, 409);
  });

  await t.test('self-service eligibility exposes only the caller record and enforces exact revisions', async () => {
    const entity = randomUUID(); const doc = randomUUID(); const hash = 'a'.repeat(64);
    let revision = 0;
    for (const [type, payload] of [['publishDocument', { documentId: doc, title: 'Release', revision: 1, sha256: hash, requiredFor: ['debater'], kind: 'release' }],
      ['enroll', { principalId: a.principalId, role: 'debater' }], ['enroll', { principalId: b.principalId, role: 'debater' }]]) {
      assert.equal((await post(organizer, 'eligibility', entity, type, payload, revision++)).status, 200);
    }
    const accepted = await post(a, 'eligibility', entity, 'accept', { documentId: doc, revision: 1, sha256: hash }, revision);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.current.view.participant.principalId, a.principalId);
    assert.equal(accepted.data.current.view.status.eligible, true);
    assert.equal(JSON.stringify(accepted.data).includes(b.principalId), false);
    assert.equal((await a.client.call(`${base}/eligibility`)).status, 404);
    const mine = await b.client.call(`${base}/eligibility/${entity}?self=participant.self`);
    assert.equal(mine.status, 200); assert.equal(mine.data.current.view.status.eligible, false);
    assert.equal((await post(a, 'eligibility', entity, 'enroll', { principalId: outsider.principalId, role: 'audience' }, revision + 1)).status, 404);
  });

  await t.test('audience self-registration and organizer allocation', async () => {
    const entity = randomUUID();
    assert.equal((await post(organizer, 'admission', entity, 'configure', { capacity: 1, policy: 'first-come', lotterySeed: null }, 0)).status, 200);
    assert.equal((await post(organizer, 'admission', entity, 'open', {}, 1)).status, 200);
    const registered = await post(outsider, 'admission', entity, 'register', {}, 2);
    assert.equal(registered.status, 200, JSON.stringify(registered.data)); assert.equal(registered.data.current.view.registration.status, 'requested');
    const allocated = await post(organizer, 'admission', entity, 'allocate', { confirm: true }, 3);
    assert.equal(allocated.data.current.snapshot.data.state.registrations[0].status, 'admitted');
    const view = await outsider.client.call(`${base}/admission/${entity}?self=participant.self`);
    assert.equal(view.data.current.view.registration.status, 'admitted');
  });

  await t.test('E13-E19 live streams enforce role-specific actions over real HTTP', async () => {
    const moderator = await x.register('moderator', 'moderator'); const timekeeper = await x.register('timekeeper', 'timekeeper');
    const live = randomUUID(); const floor = randomUUID(); const questions = randomUUID();
    assert.equal((await post(moderator, 'live', live, 'advance', { from: 'preparation', to: 'readiness' }, 0)).status, 200);
    assert.equal((await post(a, 'live', live, 'advance', { from: 'readiness', to: 'pre-vote' }, 1)).status, 404);
    assert.equal((await post(moderator, 'live', live, 'announce', { from: 'readiness', to: 'pre-vote' }, 1)).status, 404);
    assert.equal((await post(moderator, 'live', live, 'advance', { from: 'readiness', to: 'pre-vote' }, 1)).status, 422);
    const started = await post(timekeeper, 'floor', floor, 'startSpeech', { speakerId: a.principalId, segment: 'opening-for', seconds: 420, graceSeconds: 10, protectedSeconds: 0 }, 0);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal((await post(moderator, 'floor', floor, 'startSpeech', { speakerId: b.principalId, segment: 'x', seconds: 1, graceSeconds: 0, protectedSeconds: 0 }, 1)).status, 409);
    const point = await post(b, 'floor', floor, 'raisePoint', { pointId: randomUUID(), kind: 'order' }, 1);
    assert.equal(point.status, 200, JSON.stringify(point.data));
    assert.equal((await post(outsider, 'floor', floor, 'requestFloor', {}, 2)).status, 404);
    assert.equal((await post(moderator, 'questions', questions, 'setOpen', { open: true }, 0)).status, 200);
    const asked = await post(outsider, 'questions', questions, 'submit', { questionId: randomUUID(), text: 'What evidence supports this?', directedTo: 'both' }, 1);
    assert.equal(asked.status, 200, JSON.stringify(asked.data)); assert.equal(asked.data.current.view.mine.length, 1);
    assert.equal((await outsider.client.call(`${base}/questions`)).status, 404);
    assert.equal((await moderator.client.call(`${base}/questions`)).data.records[0].snapshot.data.state.questions[0].author, outsider.principalId);
    const media = await post(x.organizer, 'media', randomUUID(), 'openRoom', {}, 0);
    assert.equal(media.status, 404); // organizer is not the producer; media.control is producer-only
  });

  await t.test('E20-E23 secret ballot: blind issuance, anonymous casting, pairing and verified tally', async () => {
    const moderator = await x.register('ballot-moderator', 'moderator'); const producer = await x.register('producer', 'producer');
    const poll = randomUUID(); const ballots = `/api/tenants/${f.tenantId}/events/${f.eventId}/ballots/${poll}`;
    const locked = await post(organizer, 'poll', poll, 'lockElectorate', { principalIds: [outsider.principalId] }, 0);
    assert.equal(locked.status, 200, JSON.stringify(locked.data));
    assert.equal(locked.data.current.snapshot.data.state.sealedKey, null); assert.equal(locked.data.current.redacted, true);
    const key = (await outsider.client.call(`${ballots}/key`)).data.publicKey;
    const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    const blinded = blind(token, key);
    assert.equal((await a.client.call(`${ballots}/issue`, { method: 'POST', body: { blinded: blinded.blinded } })).status, 404); // not an elector
    const issued = await outsider.client.call(`${ballots}/issue`, { method: 'POST', body: { blinded: blinded.blinded } });
    assert.equal(issued.status, 200, JSON.stringify(issued.data));
    assert.equal((await outsider.client.call(`${ballots}/issue`, { method: 'POST', body: { blinded: blind(token, key).blinded } })).status, 409);
    const signature = unblind(issued.data.blindSignature, blinded.r, key);
    const cast = (round, choice, sig = signature) => fetch(`${x.origin}${ballots}/cast`, { method: 'POST', headers: { origin: x.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token, signature: sig, round, choice }) }).then(async (r) => ({ status: r.status, data: await r.json() }));
    assert.equal((await cast('pre', 'against')).status, 409); // round not open
    assert.equal((await post(moderator, 'poll', poll, 'open', { round: 'pre' }, 1)).status, 200);
    assert.equal((await cast('pre', 'against', signature.slice(0, -3) + 'AAA')).status, 403);
    const receipt = await cast('pre', 'against'); assert.equal(receipt.status, 200); assert.match(receipt.data.receipt, /^[a-f0-9]{64}$/);
    assert.equal((await cast('pre', 'for')).status, 409); // one ballot per round per credential
    const withCookie = await outsider.client.call(`${ballots}/cast`, { method: 'POST', body: { token, signature, round: 'pre', choice: 'for' } });
    assert.equal(withCookie.status, 400);
    for (const [type, round] of [['close', 'pre'], ['open', 'post']]) assert.equal((await post(moderator, 'poll', poll, type, { round }, type === 'close' ? 2 : 3)).status, 200);
    assert.equal((await cast('post', 'for')).status, 200);
    assert.equal((await post(moderator, 'poll', poll, 'close', { round: 'post' }, 4)).status, 200);
    const stored = await admin.query('SELECT * FROM lde_competition.ballots WHERE poll_id=$1', [poll]);
    assert.equal(stored.rowCount, 2); assert.equal(JSON.stringify(stored.rows).includes(outsider.principalId), false);
    const board = await outsider.client.call(`${ballots}/receipts`);
    assert.ok(board.data.receipts.includes(receipt.data.receipt));
    assert.equal((await outsider.client.call(`${ballots}/tally`)).status, 404);
    const results = randomUUID();
    const computed = await post(producer, 'results', results, 'computeAudience', { pollId: poll, paperEntityId: null }, 0);
    assert.equal(computed.status, 200, JSON.stringify(computed.data));
    const verdict = computed.data.current.snapshot.data.state.audience.verdict;
    assert.equal(verdict.cohort, 1); assert.equal(verdict.decision, 'for'); assert.deepEqual(verdict.gain, { for: 1, against: -1 });
    await assert.rejects(admin.query('UPDATE lde_competition.ballots SET choice=$1 WHERE poll_id=$2', ['for', poll]));

    // E-24..E-26: seated judge scores privately; verifier records the panel verdict from stored cards.
    const judge = await x.register('judge', 'judge'); const oversight = await x.register('oversight', 'oversight');
    const panel = randomUUID(); const card = randomUUID();
    const rubric = [{ code: 'argument', label: 'Argument', weightBps: 10000, minimum: 0, maximum: 10 }];
    const caps = { penaltyMaxPerFinding: 2, penaltyTotalCap: 4, bonusMaxPerFinding: 2, bonusTotalCap: 4 };
    assert.equal((await post(organizer, 'panel', panel, 'configure', { rubric, caps, aggregation: 'mean', judges: [judge.principalId] }, 0)).status, 200);
    assert.equal((await post(organizer, 'panel', panel, 'open', { confirm: true }, 1)).status, 200);
    const injected = await post(judge, 'scorecard', card, 'submit', { panelId: panel, panel: { rubric: [] }, entries: { for: { argument: 8 }, against: { argument: 6 } }, adjustments: [], notes: '' }, 0);
    assert.equal(injected.status, 400);
    const scored = await post(judge, 'scorecard', card, 'submit', { panelId: panel, entries: { for: { argument: 8 }, against: { argument: 6 } }, adjustments: [], notes: 'Synthetic' }, 0);
    assert.equal(scored.status, 200, JSON.stringify(scored.data)); assert.equal(scored.data.current.view.status, 'submitted');
    assert.equal((await post(producer, 'scorecard', randomUUID(), 'submit', { panelId: panel, entries: { for: {}, against: {} }, adjustments: [], notes: '' }, 0)).status, 404);
    assert.equal((await post(organizer, 'panel', panel, 'close', {}, 2)).status, 200);
    const judged = await post(producer, 'results', results, 'recordJudges', { panelId: panel }, 1);
    assert.equal(judged.status, 200, JSON.stringify(judged.data));
    const state = judged.data.current.snapshot.data.state;
    assert.equal(state.judges.verdict.decision, 'for'); assert.equal(state.judges.verdict.submitted, 1);
    assert.equal((await post(producer, 'results', results, 'verify', { resultsHash: state.resultsHash, confirm: true }, 2)).status, 200);
    assert.equal((await post(oversight, 'results', results, 'verify', { resultsHash: state.resultsHash, confirm: true }, 3)).status, 200);
    assert.equal((await post(producer, 'results', results, 'certify', { resultsHash: state.resultsHash }, 4)).status, 422);
  });

  await t.test('E27-E31 prize, dispute and payout streams enforce finance/oversight/self roles', async () => {
    const finance = await x.register('finance', 'finance');
    const prizes = randomUUID(); const disputes = randomUUID(); const payouts = randomUUID();
    assert.equal((await post(finance, 'prizes', prizes, 'fund', { currency: 'CAD', exponent: 2, budget: '100000' }, 0)).status, 200);
    assert.equal((await post(organizer, 'prizes', prizes, 'fund', { currency: 'CAD', exponent: 2, budget: '999999' }, 1)).status, 404);
    assert.equal((await post(organizer, 'disputes', disputes, 'setWindow', { closesAt: new Date(Date.now() + 3600000).toISOString() }, 0)).status, 200);
    const filed = await post(a, 'disputes', disputes, 'file', { disputeId: randomUUID(), subject: 'results', reason: 'counting-error', statement: 'Synthetic dispute statement for integration testing.', evidence: [] }, 1);
    assert.equal(filed.status, 200, JSON.stringify(filed.data)); assert.equal(filed.data.current.view.mine.length, 1);
    assert.equal((await a.client.call(`${base}/disputes`)).status, 404);
    // Payment provider is disabled without keys: onboarding fails closed and records nothing.
    const onboarding = await post(a, 'payouts', payouts, 'startOnboarding', {}, 0);
    assert.equal(onboarding.status, 409); assert.equal(onboarding.data.error, 'payment_provider_unconfigured');
  });

  await t.test('E33/E37 public catalog exposes only published, non-identifying data without credentials', async () => {
    const listed = await fetch(`${x.origin}/api/public/v1/tenants/${f.tenantId}/events`).then((r) => r.json());
    assert.equal(listed.apiVersion, 'public-v1');
    const event = listed.events.find((e) => e.title === 'Synthetic Housing Debate');
    assert.ok(event, JSON.stringify(listed)); assert.equal(event.motion.revision, 3);
    assert.equal(JSON.stringify(listed).includes(organizer.principalId), false);
    const detail = await fetch(`${x.origin}/api/public/v1/tenants/${f.tenantId}/events/${event.eventId}/package`).then((r) => r.json());
    assert.match(detail.manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal((await fetch(`${x.origin}/api/public/v1/tenants/${f.tenantId}/events/${randomUUID()}`)).status, 404);
  });

  await t.test('E34-E37 editorial publishing, white-label branding and signed webhook delivery', async () => {
    const listed = await fetch(`${x.origin}/api/public/v1/tenants/${f.tenantId}/events`).then((r) => r.json());
    const published = listed.events.find((e) => e.title === 'Synthetic Housing Debate');
    const ed = `/api/tenants/${f.tenantId}/events/${published.eventId}/operations/editorial`;
    // Webhook subscription first, so the editorial snapshots are enqueued.
    const hook = randomUUID();
    const created = await organizer.client.call(`/api/tenants/${f.tenantId}/webhooks/${hook}`, { method: 'POST', body: { url: 'https://hooks.example.com/lde', kinds: ['operation:editorial'], active: true, rotateSecret: true } });
    assert.equal(created.status, 200, JSON.stringify(created.data)); assert.match(created.data.signingSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await outsider.client.call(`/api/tenants/${f.tenantId}/webhooks/${randomUUID()}`, { method: 'POST', body: { url: 'https://hooks.example.com/x', kinds: ['*'], active: true, rotateSecret: true } })).status, 404);
    assert.equal((await organizer.client.call(`/api/tenants/${f.tenantId}/webhooks/${randomUUID()}`, { method: 'POST', body: { url: 'http://hooks.example.com/x', kinds: ['*'], active: true, rotateSecret: true } })).status, 400);
    const article = randomUUID(); const editor = await x.register('editor', 'producer');
    await administerAccess(admin, 'role', { principalId: editor.principalId, tenantId: f.tenantId, eventId: published.eventId, role: 'producer', expiresAt: null, revoked: 'no', reason: 'Synthetic editorial reviewer role' });
    const step = (u, type, payload, rev) => u.client.call(`${ed}/${article}`, { method: 'POST', body: { commandId: randomUUID(), expectedRevision: rev, type, payload } });
    assert.equal((await step(organizer, 'draft', { articleId: article, kind: 'summary', headline: 'Parking debate summary', body: 'A synthetic summary of the parking minimums debate.', channels: ['public-site'] }, 0)).status, 200);
    assert.equal((await step(organizer, 'submit', { articleId: article }, 1)).status, 200);
    assert.equal((await step(organizer, 'approve', { articleId: article, note: 'self' }, 2)).status, 403);
    assert.equal((await step(editor, 'approve', { articleId: article, note: 'Checked' }, 2)).status, 200);
    assert.equal((await step(editor, 'publish', { articleId: article, publishAt: new Date(Date.now() - 1000).toISOString() }, 3)).status, 200);
    const detail = await fetch(`${x.origin}/api/public/v1/tenants/${f.tenantId}/events/${published.eventId}`).then((r) => r.json());
    assert.equal(detail.event.editorial[0].headline, 'Parking debate summary');
    // Branding
    const brand = { name: 'Synthetic Forum', shortName: 'SF', tagline: 'Test', locale: 'en-CA', supportEmail: null, colors: { background: '#ffffff', text: '#111111', primary: '#174f79', accent: '#a17c31' }, typography: 'sans', customDomains: [], footer: '', features: { audienceQuestions: true, publicResults: true, transcripts: false } };
    assert.equal((await organizer.client.call(`/api/tenants/${f.tenantId}/branding`, { method: 'POST', body: { expectedRevision: 0, brand: { ...brand, colors: { ...brand.colors, text: '#eeeeee' } } } })).status, 400);
    assert.equal((await organizer.client.call(`/api/tenants/${f.tenantId}/branding`, { method: 'POST', body: { expectedRevision: 0, brand } })).status, 200);
    assert.equal((await organizer.client.call(`/api/tenants/${f.tenantId}/branding`, { method: 'POST', body: { expectedRevision: 0, brand } })).status, 409);
    assert.equal((await fetch(`${x.origin}/api/public/v1/tenants/${f.tenantId}/brand`).then((r) => r.json())).brand.name, 'Synthetic Forum');
    // Webhook delivery: 4 editorial snapshots (draft, submit, approve, publish) were enqueued.
    const sent = [];
    const worker = new WebhookWorker(appPool, x.ballotSecret, async (url, init) => { sent.push(init); return { status: 200, body: null }; }, async () => ['93.184.216.34']);
    assert.equal(await worker.tick(20), 4);
    assert.ok(sent.every((init) => verifyWebhook(created.data.signingSecret, init.body, init.headers['x-lde-signature'], Math.floor(Date.now() / 1000))));
    assert.ok(sent.every((init) => !init.body.includes('Parking debate summary')));
    assert.equal(await worker.tick(20), 0);
    const list = await organizer.client.call(`/api/tenants/${f.tenantId}/webhooks`);
    assert.equal(list.data.webhooks[0].pending, 0);
  });

  await t.test('direct SQL cannot bypass the stream/action allow-list', async () => {
    const call = (action, stream = 'roster') => withCredential(appPool, organizer.token, (client) => client.query('SELECT lde_competition.save_operation($1,$2,$3,$4,$5,0,$6,$7,$8)',
      [f.tenantId, f.eventId, stream, action, randomUUID(), '{}', 'b'.repeat(64), randomUUID()]));
    await assert.rejects(call('participant.self'), (e) => e.code === '42501');
    await assert.rejects(call('event.manage', 'unregistered'), (e) => e.code === '42501');
    await assert.rejects(withCredential(appPool, outsider.token, (client) => client.query('SELECT lde_competition.operation_records($1,$2,$3,$4,NULL,1)', [f.tenantId, f.eventId, 'admission', 'event.manage'])), (e) => e.code === '42501');
    await assert.rejects(appPool.query('SELECT * FROM lde_competition.operation_streams'), (e) => e.code === '42501');
  });
}

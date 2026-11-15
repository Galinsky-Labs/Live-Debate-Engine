import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withCredential } from '../../dist/packages/identity/src/broker.js';

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

  await t.test('direct SQL cannot bypass the stream/action allow-list', async () => {
    const call = (action, stream = 'roster') => withCredential(appPool, organizer.token, (client) => client.query('SELECT lde_competition.save_operation($1,$2,$3,$4,$5,0,$6,$7,$8)',
      [f.tenantId, f.eventId, stream, action, randomUUID(), '{}', 'b'.repeat(64), randomUUID()]));
    await assert.rejects(call('participant.self'), (e) => e.code === '42501');
    await assert.rejects(call('event.manage', 'unregistered'), (e) => e.code === '42501');
    await assert.rejects(withCredential(appPool, outsider.token, (client) => client.query('SELECT lde_competition.operation_records($1,$2,$3,$4,NULL,1)', [f.tenantId, f.eventId, 'admission', 'event.manage'])), (e) => e.code === '42501');
    await assert.rejects(appPool.query('SELECT * FROM lde_competition.operation_streams'), (e) => e.code === '42501');
  });
}

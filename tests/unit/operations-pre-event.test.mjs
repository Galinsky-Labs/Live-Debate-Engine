import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyCommand } from '../../dist/packages/competition/src/operations/stream.js';
import { rosterStream, rosterProblems } from '../../dist/packages/competition/src/operations/roster.js';
import { eligibilityStream, evaluateEligibility } from '../../dist/packages/competition/src/operations/eligibility.js';
import { scheduleStream, chronologyProblems, resourceConflicts, renderMessage, dueMessages } from '../../dist/packages/competition/src/operations/schedule.js';
import { admissionStream, allocationOrder, seatsRemaining } from '../../dist/packages/competition/src/operations/admission.js';

const ids = { entityId: randomUUID(), eventId: randomUUID(), tenantId: randomUUID() };
const organizer = randomUUID();
const at = (minute) => new Date(Date.UTC(2027, 0, 1, 18, minute)).toISOString();
function run(stream, steps, actor = organizer) {
  let state = stream.initial(ids); let minute = 0;
  for (const [type, payload, who = actor] of steps) state = applyCommand(stream, state, type, payload, { actor: who, now: at(minute++) }).state;
  return state;
}
const sha = (c) => c.repeat(64);

test('E-09 roster: lock requires both sides, cast members, judges, moderator and no conflicts', () => {
  const [a, b, j1, j2, j3, mod] = Array.from({ length: 6 }, randomUUID); const tf = randomUUID(); const ta = randomUUID();
  const base = [['setTeam', { teamId: tf, name: 'Proposition', side: 'for', members: [a] }], ['setTeam', { teamId: ta, name: 'Opposition', side: 'against', members: [b] }],
    ['assign', { principalId: a, role: 'debater', teamId: tf }], ['assign', { principalId: b, role: 'debater', teamId: ta }],
    ['assign', { principalId: j1, role: 'judge', teamId: null }], ['assign', { principalId: j2, role: 'judge', teamId: null }]];
  const partial = run(rosterStream, base);
  assert.deepEqual(rosterProblems(partial), ['insufficient_judges', 'missing_moderator']);
  assert.throws(() => run(rosterStream, [...base, ['lock', { confirm: true }]]), /roster_incomplete/);
  const full = [...base, ['assign', { principalId: j3, role: 'judge', teamId: null }], ['assign', { principalId: mod, role: 'moderator', teamId: null }]];
  const locked = run(rosterStream, [...full, ['lock', { confirm: true }]]);
  assert.equal(locked.status, 'locked'); assert.equal(locked.lockedBy, organizer);
  assert.throws(() => run(rosterStream, [...full, ['lock', { confirm: true }], ['assign', { principalId: randomUUID(), role: 'judge', teamId: null }]]), /roster_locked/);
  assert.throws(() => run(rosterStream, [...full, ['declareConflict', { judgeId: j1, principalId: a, reason: 'Former coach' }], ['lock', { confirm: true }]]), /judge_conflict_of_interest/);
  assert.throws(() => run(rosterStream, [...base, ['assign', { principalId: a, role: 'judge', teamId: null }]]), /judge_is_debater/);
  assert.throws(() => run(rosterStream, [...base, ['setTeam', { teamId: randomUUID(), name: 'Other', side: 'for', members: [a] }]]), /member_on_two_teams/);
  const reopened = run(rosterStream, [...full, ['lock', { confirm: true }], ['unlock', { reason: 'Replace an unavailable judge' }]]);
  assert.equal(reopened.status, 'draft'); assert.equal(reopened.amendments.length, 1);
  assert.throws(() => run(rosterStream, [['assign', { principalId: a, role: 'debater', teamId: null }]]), /only_debaters_have_teams/);
});

test('E-10 eligibility: acceptance binds exact revision and hash; new revision requires re-acceptance', () => {
  const debater = randomUUID(); const doc = randomUUID();
  const steps = [['publishDocument', { documentId: doc, title: 'Participant release', revision: 1, sha256: sha('a'), requiredFor: ['debater'], kind: 'release' }],
    ['setAttestations', { codes: ['age-18-plus'] }], ['enroll', { principalId: debater, role: 'debater' }]];
  assert.deepEqual(evaluateEligibility(run(eligibilityStream, steps), debater).missing, [`document:${doc}`, 'attestation:age-18-plus']);
  assert.throws(() => run(eligibilityStream, [...steps, ['accept', { documentId: doc, revision: 1, sha256: sha('b') }, debater]]), /document_changed/);
  const accepted = run(eligibilityStream, [...steps, ['accept', { documentId: doc, revision: 1, sha256: sha('a') }, debater], ['attest', { code: 'age-18-plus' }, debater]]);
  assert.equal(evaluateEligibility(accepted, debater).eligible, true);
  const revised = applyCommand(eligibilityStream, accepted, 'publishDocument', { documentId: doc, title: 'Participant release', revision: 2, sha256: sha('c'), requiredFor: ['debater'], kind: 'release' }, { actor: organizer, now: at(30) }).state;
  assert.deepEqual(evaluateEligibility(revised, debater).missing, [`document:${doc}`]);
  assert.throws(() => applyCommand(eligibilityStream, revised, 'publishDocument', { documentId: doc, title: 'Old', revision: 1, sha256: sha('a'), requiredFor: ['debater'], kind: 'release' }, { actor: organizer, now: at(31) }), /revision_must_increase/);
  assert.throws(() => run(eligibilityStream, [...steps, ['review', { principalId: organizer, decision: 'eligible', reason: 'self check' }]]), /not_registered/);
  const view = eligibilityStream.view(accepted, debater);
  assert.equal(view.participant.principalId, debater); assert.equal(view.status.eligible, true);
  assert.equal(eligibilityStream.view(accepted, randomUUID()).participant, null);
});

test('E-11 schedule: chronology, resource clashes, safe templates and preview-only delivery', () => {
  const start = randomUUID();
  const item = (kind, s, e, resources = []) => ['setItem', { itemId: kind === 'start' ? start : randomUUID(), kind, label: kind, startAt: at(s), endAt: at(e), resources }];
  const state = run(scheduleStream, [['setTimeZone', { timeZone: 'America/Vancouver' }], item('call', 0, 10), item('doors', 20, 30), item('start', 30, 90, [{ kind: 'venue', resourceId: 'hall-a' }]), item('end', 90, 90)]);
  assert.deepEqual(chronologyProblems(state), []);
  assert.throws(() => run(scheduleStream, [item('start', 30, 90), item('doors', 40, 45)]), /doors_after_start/);
  const clash = resourceConflicts([{ eventId: 'e1', item: state.items.find((i) => i.kind === 'start') }, { eventId: 'e2', item: { ...state.items.find((i) => i.kind === 'start'), startAt: at(60), endAt: at(120) } }]);
  assert.equal(clash.length, 1); assert.equal(clash[0].overlapStartsAt, at(60));
  assert.equal(renderMessage('Welcome to {{ eventTitle }} at {{venue}}', { eventTitle: 'Debate <b>', startLocal: '', venue: 'Hall', timeZone: '' }), 'Welcome to Debate b at Hall');
  assert.throws(() => renderMessage('{{ secret }}', { eventTitle: '', startLocal: '', venue: '', timeZone: '' }), /unknown_template_variable/);
  const message = randomUUID();
  const comms = run(scheduleStream, [['draftMessage', { messageId: message, audience: 'all', subject: 'Reminder', template: 'See you at {{venue}}', sendAt: at(5) }], ['approveMessage', { messageId: message }]]);
  assert.equal(dueMessages(comms, at(4)).length, 0); assert.equal(dueMessages(comms, at(6)).length, 1);
  assert.throws(() => run(scheduleStream, [['draftMessage', { messageId: message, audience: 'all', subject: 'x', template: '{{token}}', sendAt: at(5) }]]), /unknown_template_variable/);
});

test('E-12 admission: deterministic allocation, waitlist promotion, self-only actions and check-in', () => {
  const people = Array.from({ length: 4 }, randomUUID);
  const steps = [['configure', { capacity: 2, policy: 'first-come', lotterySeed: null }], ['open', {}], ...people.map((p) => ['register', {}, p]), ['allocate', { confirm: true }]];
  const allocated = run(admissionStream, steps);
  assert.deepEqual(allocated.registrations.map((r) => r.status), ['admitted', 'admitted', 'waitlisted', 'waitlisted']);
  assert.equal(seatsRemaining(allocated), 0);
  const cancelled = applyCommand(admissionStream, allocated, 'cancel', {}, { actor: people[0], now: at(40) }).state;
  assert.equal(cancelled.registrations.find((r) => r.principalId === people[2]).status, 'admitted');
  assert.equal(admissionStream.view(cancelled, people[3]).waitlistPosition, 1);
  assert.throws(() => run(admissionStream, [...steps, ['register', {}, people[1]]]), /already_registered/);
  assert.throws(() => run(admissionStream, [...steps, ['checkIn', { principalId: people[3] }]]), /not_admitted/);
  const checked = run(admissionStream, [...steps, ['checkIn', { principalId: people[0] }]]);
  assert.equal(checked.registrations[0].status, 'checked-in');
  const seed = sha('d');
  const lottery = run(admissionStream, [['configure', { capacity: 2, policy: 'lottery', lotterySeed: seed }], ['open', {}], ...people.map((p) => ['register', {}, p])]);
  assert.deepEqual(allocationOrder(lottery).map((r) => r.principalId), allocationOrder({ ...lottery, registrations: [...lottery.registrations].reverse() }).map((r) => r.principalId));
  assert.throws(() => run(admissionStream, [['configure', { capacity: 2, policy: 'lottery', lotterySeed: null }]]), /lottery_requires_published_seed/);
  assert.throws(() => run(admissionStream, [['register', {}, people[0]]]), /registration_closed/);
});

test('streams reject unknown commands and malformed payloads', () => {
  for (const stream of [rosterStream, eligibilityStream, scheduleStream, admissionStream]) {
    assert.throws(() => applyCommand(stream, stream.initial(ids), 'drop', {}, { actor: organizer, now: at(0) }), /unknown_command/);
    assert.throws(() => applyCommand(stream, stream.initial(ids), Object.keys(stream.commands)[0], { injected: true }, { actor: organizer, now: at(0) }), /invalid_/);
  }
});

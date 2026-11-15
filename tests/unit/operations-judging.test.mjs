import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyCommand } from '../../dist/packages/competition/src/operations/stream.js';
import { panelStream } from '../../dist/packages/competition/src/operations/panel.js';
import { scorecardStream } from '../../dist/packages/competition/src/operations/scorecard.js';
import { judgeDecision, panelVerdict, sideTotal, cmp, rational } from '../../dist/packages/competition/src/operations/judging.js';
import { resultsStream } from '../../dist/packages/competition/src/operations/results.js';
import { matrixFromPairs } from '../../dist/packages/competition/src/operations/outcome.js';

const scope = { tenantId: randomUUID(), eventId: randomUUID(), entityId: randomUUID() };
const ctx = (actor, n = 0) => ({ actor, now: new Date(Date.UTC(2027, 0, 1, 20, n)).toISOString(), scope });
const organizer = randomUUID(); const judges = [randomUUID(), randomUUID(), randomUUID()];
const rubric = [{ code: 'argument', label: 'Argument', weightBps: 6000, minimum: 0, maximum: 10 }, { code: 'delivery', label: 'Delivery', weightBps: 4000, minimum: 1, maximum: 5 }];
const caps = { penaltyMaxPerFinding: 2, penaltyTotalCap: 3, bonusMaxPerFinding: 2, bonusTotalCap: 2 };
function openPanel() {
  let s = applyCommand(panelStream, panelStream.initial(scope), 'configure', { rubric, caps, aggregation: 'mean', judges }, ctx(organizer)).state;
  return applyCommand(panelStream, s, 'open', { confirm: true }, ctx(organizer)).state;
}

test('E-24 scorecards: seated judge only, owner-bound, sealed on submit, rubric from the panel', () => {
  const panel = openPanel(); const panelId = randomUUID();
  const card = (judge, type, entries, adjustments = []) => applyCommand(scorecardStream, scorecardStream.initial(scope), type, { panel, panelId, entries, adjustments, notes: '' }, ctx(judge)).state;
  assert.throws(() => card(randomUUID(), 'saveDraft', { for: {}, against: {} }), /not_seated/);
  const draft = card(judges[0], 'saveDraft', { for: { argument: 7 }, against: {} });
  assert.throws(() => applyCommand(scorecardStream, draft, 'saveDraft', { panel, panelId, entries: { for: {}, against: {} }, adjustments: [], notes: '' }, ctx(judges[1])), /not_your_scorecard/);
  assert.throws(() => card(judges[0], 'submit', { for: { argument: 7 }, against: {} }), /incomplete_against/);
  assert.throws(() => card(judges[0], 'saveDraft', { for: { argument: 11 }, against: {} }), /invalid_for_argument/);
  const submitted = card(judges[0], 'submit', { for: { argument: 7, delivery: 4 }, against: { argument: 6, delivery: 5 } });
  assert.equal(submitted.status, 'submitted');
  assert.throws(() => applyCommand(scorecardStream, submitted, 'saveDraft', { panel, panelId, entries: { for: {}, against: {} }, adjustments: [], notes: '' }, ctx(judges[0])), /scorecard_sealed/);
  assert.equal(scorecardStream.view(submitted, judges[1]), null);
});

test('E-25 rubric aggregation is exact; penalties and virtues are capped and not double counted', () => {
  const entries = { for: { argument: 10, delivery: 1 }, against: { argument: 0, delivery: 5 } };
  assert.deepEqual(sideTotal(rubric, entries, [], 'for'), rational(60n, 1n));
  assert.deepEqual(sideTotal(rubric, entries, [], 'against'), rational(40n, 1n));
  const adjusted = judgeDecision(judges[0], rubric, entries, [{ side: 'for', kind: 'penalty', points: 2, finding: 'New argument in closing', evidence: '31:20' }]);
  assert.deepEqual(adjusted.for, rational(58n, 1n)); assert.equal(adjusted.decision, 'for');
  const panel = openPanel(); const panelId = randomUUID();
  const adj = (adjustments) => applyCommand(scorecardStream, scorecardStream.initial(scope), 'saveDraft', { panel, panelId, entries: { for: {}, against: {} }, adjustments, notes: '' }, ctx(judges[0]));
  assert.throws(() => adj([{ side: 'for', kind: 'penalty', points: 3, finding: 'x1x', evidence: 'eee' }]), /penalty_cap_for/);
  assert.throws(() => adj([{ side: 'for', kind: 'penalty', points: 2, finding: 'Interrupting', evidence: 'eee' }, { side: 'for', kind: 'penalty', points: 1, finding: 'interrupting', evidence: 'eee' }]), /double_counted_for/);
  // One third must not round: 1/3 vs 0.333333333.
  assert.equal(cmp(rational(1n, 3n), rational(333333333n, 1000000000n)), 1);
  const d = (j, f, a) => judgeDecision(j, rubric, { for: { argument: f, delivery: 1 }, against: { argument: a, delivery: 1 } }, []);
  assert.equal(panelVerdict([d(judges[0], 6, 5), d(judges[1], 6, 5), d(judges[2], 0, 10)], 3, 'mean').decision, 'against');
  assert.equal(panelVerdict([d(judges[0], 6, 5), d(judges[1], 6, 5), d(judges[2], 0, 10)], 3, 'majority').decision, 'for');
  assert.equal(panelVerdict([d(judges[0], 6, 5), d(judges[1], 6, 5)], 3, 'mean').decision, 'inconclusive');
});

test('E-26 certification: hash-bound double verification, independent certifier, announcement and audited reopening', () => {
  const [v1, v2, cert] = [randomUUID(), randomUUID(), randomUUID()];
  let s = applyCommand(resultsStream, resultsStream.initial(scope), 'computeAudience', { pollId: randomUUID(), electronic: matrixFromPairs([{ pre: 'against', post: 'for' }]), paper: matrixFromPairs([]), electorateDigest: 'a'.repeat(64), issued: 1 }, ctx(v1)).state;
  const hash = s.resultsHash;
  assert.throws(() => applyCommand(resultsStream, s, 'certify', { resultsHash: hash }, ctx(cert)), /two_verifications_required/);
  assert.throws(() => applyCommand(resultsStream, s, 'verify', { resultsHash: 'b'.repeat(64), confirm: true }, ctx(v1)), /results_changed/);
  s = applyCommand(resultsStream, s, 'verify', { resultsHash: hash, confirm: true }, ctx(v1)).state;
  assert.throws(() => applyCommand(resultsStream, s, 'verify', { resultsHash: hash, confirm: true }, ctx(v1)), /already_verified/);
  s = applyCommand(resultsStream, s, 'verify', { resultsHash: hash, confirm: true }, ctx(v2)).state;
  assert.throws(() => applyCommand(resultsStream, s, 'certify', { resultsHash: hash }, ctx(v2)), /independent/);
  s = applyCommand(resultsStream, s, 'certify', { resultsHash: hash }, ctx(cert)).state;
  assert.equal(s.status, 'certified'); assert.deepEqual(s.advancement, { selectedSide: 'for', reason: 'audience' });
  assert.throws(() => applyCommand(resultsStream, s, 'computeAudience', { pollId: randomUUID(), electronic: matrixFromPairs([]), paper: matrixFromPairs([]), electorateDigest: 'a'.repeat(64), issued: 0 }, ctx(v1)), /results_certified/);
  s = applyCommand(resultsStream, s, 'announce', {}, ctx(cert)).state;
  s = applyCommand(resultsStream, s, 'reopen', { reason: 'Counting error found in batch 2' }, ctx(cert)).state;
  assert.equal(s.version, 2); assert.equal(s.status, 'computing'); assert.equal(s.verifications.length, 0); assert.notEqual(s.resultsHash, hash);
  assert.equal(s.corrections[0].previousHash, hash);
  const empty = applyCommand(resultsStream, resultsStream.initial(scope), 'computeAudience', { pollId: randomUUID(), electronic: matrixFromPairs([]), paper: matrixFromPairs([]), electorateDigest: 'a'.repeat(64), issued: 0 }, ctx(v1)).state;
  let held = applyCommand(resultsStream, empty, 'verify', { resultsHash: empty.resultsHash, confirm: true }, ctx(v1)).state;
  held = applyCommand(resultsStream, held, 'verify', { resultsHash: empty.resultsHash, confirm: true }, ctx(v2)).state;
  assert.throws(() => applyCommand(resultsStream, held, 'certify', { resultsHash: empty.resultsHash }, ctx(cert)), /held_for_review/);
});

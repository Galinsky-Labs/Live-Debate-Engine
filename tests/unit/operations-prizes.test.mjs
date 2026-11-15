import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyCommand } from '../../dist/packages/competition/src/operations/stream.js';
import { apportion } from '../../dist/packages/competition/src/operations/money.js';
import { prizesStream, standardPrizeRows, committed } from '../../dist/packages/competition/src/operations/prizes.js';
import { bracketStream, seedOrder, placements, placementAwards } from '../../dist/packages/competition/src/operations/bracket.js';
import { disputesStream } from '../../dist/packages/competition/src/operations/disputes.js';
import { createPayoutsStream, disabledPaymentProvider, simulatedPaymentProvider } from '../../dist/packages/competition/src/operations/payouts.js';

const scope = { tenantId: randomUUID(), eventId: randomUUID(), entityId: randomUUID() };
const ctx = (actor, n = 0) => ({ actor, now: new Date(Date.UTC(2027, 1, 1, 12, n)).toISOString(), scope });
const run = (stream, state, type, payload, actor, n) => applyCommand(stream, state, type, payload, ctx(actor, n)).state;

test('money apportionment is exact and deterministic', () => {
  assert.deepEqual(apportion('100', [{ key: 'b', weight: 1 }, { key: 'a', weight: 1 }, { key: 'c', weight: 1 }]), { a: '34', b: '33', c: '33' });
  assert.deepEqual(apportion('1000001', [{ key: 'x', weight: 1 }, { key: 'y', weight: 1 }]), { x: '500001', y: '500000' });
  assert.throws(() => apportion('10', []), /no_recipients/);
});

test('E-27 standard prize: certified results, 50/50 shares, team splits, tie split, budget and two approvals', () => {
  const [a1, a2, b1] = [randomUUID(), randomUUID(), randomUUID()];
  const roster = { status: 'locked', teams: [{ teamId: randomUUID(), name: 'P', side: 'for', members: [a1, a2] }, { teamId: randomUUID(), name: 'O', side: 'against', members: [b1] }] };
  const results = (aud, jud, status = 'certified') => ({ status, resultsHash: 'f'.repeat(64), audience: { verdict: { decision: aud } }, judges: { verdict: { decision: jud } } });
  let i = 0; const ids = () => `ob${i++}`;
  const rows = standardPrizeRows(results('for', 'tie'), roster, '1001', ids);
  const by = (who) => rows.filter((r) => r.recipient === who).reduce((s, r) => s + BigInt(r.amount), 0n);
  assert.equal(by(a1) + by(a2) + by(b1), 1001n); assert.equal(by(b1), 250n);
  assert.throws(() => standardPrizeRows(results('for', 'for', 'computing'), roster, '100', ids), /results_not_certified/);
  const [f1, f2] = [randomUUID(), randomUUID()];
  let s = run(prizesStream, prizesStream.initial(scope), 'fund', { currency: 'CAD', exponent: 2, budget: '1001' }, f1);
  s = run(prizesStream, s, 'allocateStandard', { rows, resultsHash: 'f'.repeat(64), pool: '1001' }, f1);
  assert.equal(committed(s), '1001');
  assert.throws(() => run(prizesStream, s, 'addAwards', { awards: [{ recipient: a1, amount: '1', source: 'award', basis: 'Best speaker' }] }, f1), /exceeds_prize_budget/);
  const ob = s.obligations[0];
  s = run(prizesStream, s, 'approve', { obligationId: ob.obligationId, confirm: true }, f1);
  assert.throws(() => run(prizesStream, s, 'approve', { obligationId: ob.obligationId, confirm: true }, f1), /already_approved/);
  assert.throws(() => run(prizesStream, s, 'approve', { obligationId: ob.obligationId, confirm: true }, ob.recipient), /self_approval_forbidden/);
  s = run(prizesStream, s, 'approve', { obligationId: ob.obligationId, confirm: true }, f2);
  assert.equal(s.obligations[0].status, 'approved');
  s = run(prizesStream, s, 'forfeit', { obligationId: s.obligations[1].obligationId, note: 'Disqualified after review' }, f2);
  assert.equal(committed(s), String(1001 - Number(rows[1].amount)));
});

test('E-28/E-29 bracket: seeding, byes, certified advancement, placements and tie-shared placement prizes', () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const teams = Array.from({ length: 6 }, (_, k) => ({ teamId: randomUUID(), name: `T${k + 1}`, seed: k + 1 }));
  const org = randomUUID();
  let s = run(bracketStream, bracketStream.initial(scope), 'seed', { teams }, org);
  assert.equal(s.rounds, 3);
  assert.equal(s.matches.find((m) => m.matchId === 'r2s1').home, teams[0].teamId); // seed 1 bye
  const hash = 'c'.repeat(64);
  const decide = (state, matchId, pick) => { const m = state.matches.find((x) => x.matchId === matchId); return run(bracketStream, state, 'recordResult', { matchId, winner: pick(m), eventId: randomUUID(), resultsHash: hash }, org); };
  assert.throws(() => run(bracketStream, s, 'recordResult', { matchId: 'r2s1', winner: teams[0].teamId, eventId: randomUUID(), resultsHash: hash }, org), /match_not_ready/);
  for (const id of ['r1s2', 'r1s4']) s = decide(s, id, (m) => m.home);
  for (const id of ['r2s1', 'r2s2']) s = decide(s, id, (m) => m.home);
  s = decide(s, 'r3s1', (m) => m.away);
  assert.equal(s.status, 'complete');
  const places = placements(s);
  assert.equal(places[0].teams.length, 1); assert.equal(places[1].place, 2); assert.equal(places[2].teams.length, 2);
  const awards = placementAwards(s, '10000', [5000, 3000, 1000, 1000]);
  assert.equal(Object.values(awards).reduce((t, v) => t + BigInt(v), 0n), 10000n);
  assert.equal(awards[places[2].teams[0]], '1000'); assert.equal(awards[places[2].teams[1]], '1000');
});

test('E-30 disputes: window, independent reviewer, remedy consistency, sanctions and correction requests', () => {
  const [filer, reviewer, org] = [randomUUID(), randomUUID(), randomUUID()];
  let s = disputesStream.initial(scope); const id = randomUUID();
  const file = (state, n) => run(disputesStream, state, 'file', { disputeId: id, subject: 'results', reason: 'counting-error', statement: 'Batch two appears to be double counted in the tally.', evidence: [] }, filer, n);
  assert.throws(() => file(s, 0), /dispute_window_closed/);
  s = run(disputesStream, s, 'setWindow', { closesAt: ctx(org, 30).now }, org);
  assert.throws(() => file(s, 31), /dispute_window_closed/);
  s = file(s, 1);
  assert.throws(() => run(disputesStream, s, 'assign', { disputeId: id }, filer), /reviewer_conflict/);
  s = run(disputesStream, s, 'assign', { disputeId: id }, reviewer);
  assert.throws(() => run(disputesStream, s, 'decide', { disputeId: id, upheld: true, remedy: 'none', reasoning: 'Upheld but without any remedy given.' }, reviewer), /remedy_must_match/);
  s = run(disputesStream, s, 'decide', { disputeId: id, upheld: true, remedy: 'recount', reasoning: 'Batch two was entered twice by the same teller.' }, reviewer);
  assert.equal(s.correctionsRequired[0].remedy, 'recount');
  s = run(disputesStream, s, 'sanction', { sanctionId: randomUUID(), principalId: filer, kind: 'disqualification', points: 0, disputeId: null, reason: 'Undisclosed outside coaching' }, reviewer);
  assert.equal(s.correctionsRequired.length, 2);
  assert.equal(disputesStream.view(s, filer).mine.length, 1); assert.equal(disputesStream.view(s, reviewer).mine.length, 0);
});

test('E-31 payouts: disabled provider fails closed, verified payee, two approvers, idempotent submission, manual settlement', async () => {
  const disabled = createPayoutsStream(disabledPaymentProvider);
  await assert.rejects(disabled.prepare('startOnboarding', {}, disabled.initial(scope), ctx(randomUUID())), /payment_provider_unconfigured/);
  const provider = simulatedPaymentProvider(); const stream = createPayoutsStream(provider);
  const [winner, f1, f2] = [randomUUID(), randomUUID(), randomUUID()];
  let s = stream.initial(scope);
  s = applyCommand(stream, s, 'startOnboarding', await stream.prepare('startOnboarding', {}, s, ctx(winner)), ctx(winner)).state;
  const payoutId = randomUUID();
  const obligation = { obligationId: 'a'.repeat(32), recipient: winner, amount: '500', currency: 'CAD', status: 'approved' };
  s = run(stream, s, 'request', { payoutId, obligation }, f1);
  assert.throws(() => run(stream, s, 'request', { payoutId: randomUUID(), obligation }, f1), /already_paid_or_pending/);
  assert.throws(() => run(stream, s, 'approve', { payoutId, confirm: true }, f1), /payee_not_verified/);
  assert.throws(() => run(stream, s, 'recordOnboarding', { principalId: winner, onboarding: 'verified', taxForm: 'verified' }, winner), /self_verification/);
  s = run(stream, s, 'recordOnboarding', { principalId: winner, onboarding: 'verified', taxForm: 'verified' }, f1);
  s = run(stream, s, 'approve', { payoutId, confirm: true }, f1);
  assert.equal(s.payouts[0].status, 'requested');
  s = run(stream, s, 'approve', { payoutId, confirm: true }, f2);
  const first = await stream.prepare('submit', { payoutId }, s, ctx(f1)); const again = await stream.prepare('submit', { payoutId }, s, ctx(f1));
  assert.equal(first.providerRef, again.providerRef);
  s = run(stream, s, 'submit', first, f1);
  s = run(stream, s, 'markPaid', { payoutId, manualReference: null }, f2);
  assert.equal(s.payouts[0].status, 'paid'); assert.equal(s.payouts[0].history.length, 5);
  assert.equal(stream.view(s, winner).payouts.length, 1); assert.equal(stream.view(s, f1).payouts.length, 0);
});

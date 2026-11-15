// E-32: complete human-operated competition, end to end through every authoritative reducer,
// real blind-signature ballots and simulated (clearly non-production) media and payment providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { applyCommand } from '../../dist/packages/competition/src/operations/stream.js';
import { rosterStream } from '../../dist/packages/competition/src/operations/roster.js';
import { eligibilityStream, evaluateEligibility } from '../../dist/packages/competition/src/operations/eligibility.js';
import { admissionStream } from '../../dist/packages/competition/src/operations/admission.js';
import { liveStream, READINESS } from '../../dist/packages/competition/src/operations/live.js';
import { floorStream } from '../../dist/packages/competition/src/operations/floor.js';
import { createPollStream } from '../../dist/packages/competition/src/operations/poll.js';
import { blind, unblind, signBlinded, openPrivateKey, pseudonymOf, verifyCredential } from '../../dist/packages/competition/src/operations/ballot-crypto.js';
import { keyContext } from '../../dist/packages/competition/src/operations/poll.js';
import { matrixFromPairs } from '../../dist/packages/competition/src/operations/outcome.js';
import { panelStream } from '../../dist/packages/competition/src/operations/panel.js';
import { scorecardStream } from '../../dist/packages/competition/src/operations/scorecard.js';
import { judgeDecision, panelVerdict } from '../../dist/packages/competition/src/operations/judging.js';
import { resultsStream } from '../../dist/packages/competition/src/operations/results.js';
import { prizesStream, standardPrizeRows } from '../../dist/packages/competition/src/operations/prizes.js';
import { createPayoutsStream, simulatedPaymentProvider } from '../../dist/packages/competition/src/operations/payouts.js';
import { disputesStream } from '../../dist/packages/competition/src/operations/disputes.js';

test('E-32 acceptance: one standard debate from casting to paid prizes, with a reviewed dispute', async () => {
  const scope = { tenantId: randomUUID(), eventId: randomUUID(), entityId: randomUUID() };
  let minute = 0; const ctx = (actor) => ({ actor, now: new Date(Date.UTC(2027, 3, 1, 17, 0) + 60000 * minute++).toISOString(), scope });
  const go = (stream, state, type, payload, actor) => applyCommand(stream, state, type, payload, ctx(actor)).state;
  const p = () => randomUUID();
  const [organizer, producer, moderator, timekeeper, oversight, finance1, finance2] = Array.from({ length: 7 }, p);
  const forTeam = [p(), p()]; const againstTeam = [p(), p()]; const judges = [p(), p(), p()];
  const audience = Array.from({ length: 9 }, p);

  // E-09 roster
  let roster = rosterStream.initial(scope); const tf = p(); const ta = p();
  roster = go(rosterStream, roster, 'setTeam', { teamId: tf, name: 'Proposition', side: 'for', members: forTeam }, organizer);
  roster = go(rosterStream, roster, 'setTeam', { teamId: ta, name: 'Opposition', side: 'against', members: againstTeam }, organizer);
  for (const m of forTeam) roster = go(rosterStream, roster, 'assign', { principalId: m, role: 'debater', teamId: tf }, organizer);
  for (const m of againstTeam) roster = go(rosterStream, roster, 'assign', { principalId: m, role: 'debater', teamId: ta }, organizer);
  for (const j of judges) roster = go(rosterStream, roster, 'assign', { principalId: j, role: 'judge', teamId: null }, organizer);
  roster = go(rosterStream, roster, 'assign', { principalId: moderator, role: 'moderator', teamId: null }, organizer);
  roster = go(rosterStream, roster, 'lock', { confirm: true }, organizer);

  // E-10 eligibility
  let elig = eligibilityStream.initial(scope); const doc = p(); const sha = 'e'.repeat(64);
  elig = go(eligibilityStream, elig, 'publishDocument', { documentId: doc, title: 'Debater release', revision: 1, sha256: sha, requiredFor: ['debater'], kind: 'release' }, organizer);
  for (const d of [...forTeam, ...againstTeam]) { elig = go(eligibilityStream, elig, 'enroll', { principalId: d, role: 'debater' }, organizer); elig = go(eligibilityStream, elig, 'accept', { documentId: doc, revision: 1, sha256: sha }, d); }
  assert.ok([...forTeam, ...againstTeam].every((d) => evaluateEligibility(elig, d).eligible));

  // E-12 admission
  let adm = go(admissionStream, admissionStream.initial(scope), 'configure', { capacity: 8, policy: 'first-come', lotterySeed: null }, organizer);
  adm = go(admissionStream, adm, 'open', {}, organizer);
  for (const a of audience) adm = go(admissionStream, adm, 'register', {}, a);
  adm = go(admissionStream, adm, 'allocate', { confirm: true }, organizer);
  const admitted = adm.registrations.filter((r) => r.status === 'admitted').map((r) => r.principalId);
  assert.equal(admitted.length, 8);

  // E-21 electorate lock (E-20 key sealed server-side)
  const secret = randomBytes(48).toString('base64url'); const pollStream = createPollStream(secret);
  let poll = pollStream.initial(scope);
  poll = applyCommand(pollStream, poll, 'lockElectorate', await pollStream.prepare('lockElectorate', { principalIds: admitted }, poll, ctx(organizer)), ctx(organizer)).state;

  // E-13 state machine + E-14 floor
  let live = go(liveStream, liveStream.initial(scope), 'advance', { from: 'preparation', to: 'readiness' }, moderator);
  for (const item of READINESS) live = go(liveStream, live, 'confirmReadiness', { item, confirmed: true }, producer);
  live = go(liveStream, live, 'advance', { from: 'readiness', to: 'pre-vote' }, moderator);

  // E-20 voters obtain blind credentials and vote anonymously in both rounds.
  const issuerKey = openPrivateKey(poll.sealedKey, secret, keyContext(scope));
  const credentials = admitted.map(() => { const token = randomBytes(32).toString('base64url'); const b = blind(token, poll.publicKey); return { token, sig: unblind(signBlinded(b.blinded, issuerKey), b.r, poll.publicKey) }; });
  assert.ok(credentials.every((c) => verifyCredential(c.token, c.sig, poll.publicKey)));
  const preChoices = ['for', 'for', 'against', 'against', 'against', 'undecided', 'undecided', 'undecided'];
  const postChoices = ['for', 'for', 'for', 'against', 'against', 'for', 'against', 'for'];
  const box = new Map();
  poll = go(pollStream, poll, 'open', { round: 'pre' }, moderator);
  credentials.forEach((c, i) => { box.set(pseudonymOf(c.token), { pre: preChoices[i] }); });
  poll = go(pollStream, poll, 'close', { round: 'pre' }, moderator);
  for (const [from, to] of [['pre-vote', 'openings'], ['openings', 'discussion'], ['discussion', 'questions'], ['questions', 'closings']]) {
    live = go(liveStream, live, 'advance', { from, to }, moderator);
    let floor = go(floorStream, floorStream.initial(scope), 'startSpeech', { speakerId: forTeam[0], segment: to, seconds: 180, graceSeconds: 10, protectedSeconds: 30 }, timekeeper);
    floor = go(floorStream, floor, 'stop', {}, timekeeper); assert.equal(floor.log.length, 1);
  }
  live = go(liveStream, live, 'advance', { from: 'closings', to: 'post-vote' }, moderator);
  poll = go(pollStream, poll, 'open', { round: 'post' }, moderator);
  credentials.slice(0, 7).forEach((c, i) => { box.get(pseudonymOf(c.token)).post = postChoices[i]; }); // one voter misses the post vote
  poll = go(pollStream, poll, 'close', { round: 'post' }, moderator);
  live = go(liveStream, live, 'advance', { from: 'post-vote', to: 'verification' }, moderator);
  const paired = matrixFromPairs([...box.values()].filter((b) => b.post));

  // E-24/E-25 judging
  let panel = go(panelStream, panelStream.initial(scope), 'configure', { rubric: [{ code: 'argument', label: 'Argument', weightBps: 7000, minimum: 0, maximum: 10 }, { code: 'delivery', label: 'Delivery', weightBps: 3000, minimum: 0, maximum: 10 }],
    caps: { penaltyMaxPerFinding: 2, penaltyTotalCap: 4, bonusMaxPerFinding: 2, bonusTotalCap: 4 }, aggregation: 'mean', judges }, organizer);
  panel = go(panelStream, panel, 'open', { confirm: true }, organizer);
  const scores = [[8, 7, 6, 7], [7, 7, 7, 8], [9, 6, 5, 7]];
  const cards = judges.map((j, i) => go(scorecardStream, scorecardStream.initial(scope), 'submit', { panel, panelId: scope.entityId, entries: { for: { argument: scores[i][0], delivery: scores[i][1] }, against: { argument: scores[i][2], delivery: scores[i][3] } }, adjustments: [], notes: '' }, j));
  const judgesVerdict = panelVerdict(cards.map((c) => judgeDecision(c.judgeId, panel.rubric, c.entries, c.adjustments)), panel.seats, panel.aggregation);

  // E-22/E-26 results and certification
  let results = go(resultsStream, resultsStream.initial(scope), 'computeAudience', { pollId: scope.entityId, electronic: paired, paper: matrixFromPairs([]), electorateDigest: poll.electorate.digest, issued: 8 }, producer);
  results = go(resultsStream, results, 'recordJudges', { panelId: scope.entityId, verdict: judgesVerdict, recused: 0 }, producer);
  assert.equal(results.audience.verdict.cohort, 7); assert.equal(results.audience.verdict.decision, 'for');
  for (const v of [producer, oversight]) results = go(resultsStream, results, 'verify', { resultsHash: results.resultsHash, confirm: true }, v);
  results = go(resultsStream, results, 'certify', { resultsHash: results.resultsHash }, organizer);
  results = go(resultsStream, results, 'announce', {}, organizer);
  live = go(liveStream, live, 'announce', { from: 'verification', to: 'announcement' }, producer);

  // E-30 dispute reviewed independently and dismissed with reasons
  let disputes = go(disputesStream, disputesStream.initial(scope), 'setWindow', { closesAt: new Date(Date.UTC(2027, 3, 3)).toISOString() }, organizer);
  const disputeId = p();
  disputes = go(disputesStream, disputes, 'file', { disputeId, subject: 'scorecard', reason: 'scoring-error', statement: 'Judge two transposed the delivery scores for the two sides.', evidence: [] }, againstTeam[0]);
  disputes = go(disputesStream, disputes, 'assign', { disputeId }, oversight);
  disputes = go(disputesStream, disputes, 'decide', { disputeId, upheld: false, remedy: 'none', reasoning: 'Scores match the judge notes; no transposition occurred.' }, oversight);
  assert.equal(disputes.correctionsRequired.length, 0);

  // E-27 prizes and E-31 payouts
  let prizes = go(prizesStream, prizesStream.initial(scope), 'fund', { currency: 'CAD', exponent: 2, budget: '200000' }, finance1);
  let n = 0; const rows = standardPrizeRows(results, roster, '200000', () => `acceptance-obligation-${n++}`);
  prizes = go(prizesStream, prizes, 'allocateStandard', { rows, resultsHash: results.resultsHash, pool: '200000' }, finance1);
  for (const o of prizes.obligations) for (const f of [finance1, finance2]) prizes = go(prizesStream, prizes, 'approve', { obligationId: o.obligationId, confirm: true }, f);
  const provider = simulatedPaymentProvider(); const payouts = createPayoutsStream(provider); let pay = payouts.initial(scope);
  for (const o of prizes.obligations) {
    if (!pay.payees.some((x) => x.principalId === o.recipient)) {
      const c = ctx(o.recipient); pay = applyCommand(payouts, pay, 'startOnboarding', await payouts.prepare('startOnboarding', {}, pay, c), c).state;
      pay = go(payouts, pay, 'recordOnboarding', { principalId: o.recipient, onboarding: 'verified', taxForm: 'verified' }, finance1);
    }
    const payoutId = p();
    pay = go(payouts, pay, 'request', { payoutId, obligation: { obligationId: o.obligationId, recipient: o.recipient, amount: o.amount, currency: prizes.currency, status: o.status } }, finance1);
    for (const f of [finance1, finance2]) pay = go(payouts, pay, 'approve', { payoutId, confirm: true }, f);
    pay = go(payouts, pay, 'submit', await payouts.prepare('submit', { payoutId }, pay, ctx(finance1)), finance1);
    pay = go(payouts, pay, 'markPaid', { payoutId, manualReference: null }, finance2);
  }
  const paidTotal = pay.payouts.filter((x) => x.status === 'paid').reduce((s, x) => s + BigInt(x.amount), 0n);
  assert.equal(paidTotal, 200000n);
  // Proposition won both audience and judges, so all money goes to the proposition team.
  assert.deepEqual([...new Set(pay.payouts.map((x) => x.payee))].sort(), [...forTeam].sort());
  live = go(liveStream, live, 'close', { from: 'announcement', to: 'closed' }, producer);
  assert.equal(live.phase, 'closed');
});

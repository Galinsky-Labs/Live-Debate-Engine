import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { applyCommand } from '../../dist/packages/competition/src/operations/stream.js';
import { blind, generateBallotKey, signBlinded, unblind, verifyCredential, pseudonymOf, receiptOf, sealPrivateKey, openPrivateKey } from '../../dist/packages/competition/src/operations/ballot-crypto.js';
import { createPollStream, voterDigest } from '../../dist/packages/competition/src/operations/poll.js';
import { paperStream, reconciledMatrix } from '../../dist/packages/competition/src/operations/paper.js';
import { audienceVerdict, matrixFromPairs, addMatrices, advancement, compareRational } from '../../dist/packages/competition/src/operations/outcome.js';
import { resultsStream } from '../../dist/packages/competition/src/operations/results.js';

const key = generateBallotKey();
const scope = { tenantId: randomUUID(), eventId: randomUUID(), entityId: randomUUID() };
const ctx = (actor, n = 0) => ({ actor, now: new Date(Date.UTC(2027, 0, 1, 18, n)).toISOString(), scope });

test('E-20 blind signatures: valid credentials verify, are unlinkable to the blinded value, and resist forgery', () => {
  const token = randomBytes(32).toString('base64url');
  const { blinded, r } = blind(token, key.publicKey);
  const signature = unblind(signBlinded(blinded, key.privateJwk), r, key.publicKey);
  assert.equal(verifyCredential(token, signature, key.publicKey), true);
  assert.notEqual(blinded, signature); assert.equal(blinded.includes(token), false);
  assert.equal(verifyCredential(randomBytes(32).toString('base64url'), signature, key.publicKey), false);
  assert.equal(verifyCredential(token, signature.slice(0, -2) + 'AA', key.publicKey), false);
  const other = generateBallotKey();
  assert.equal(verifyCredential(token, signature, other.publicKey), false);
  // Two blindings of the same token differ, so the issuer cannot correlate re-requests.
  assert.notEqual(blind(token, key.publicKey).blinded, blinded);
  assert.equal(pseudonymOf(token).length, 64); assert.notEqual(receiptOf(pseudonymOf(token), 'pre', 'for'), receiptOf(pseudonymOf(token), 'post', 'for'));
  const sealed = sealPrivateKey(key.privateJwk, 'x'.repeat(64), 'poll:a');
  assert.equal(openPrivateKey(sealed, 'x'.repeat(64), 'poll:a'), key.privateJwk);
  assert.throws(() => openPrivateKey(sealed, 'x'.repeat(64), 'poll:b'));
  assert.throws(() => openPrivateKey(sealed, 'y'.repeat(64), 'poll:a'));
});

test('E-21 poll: irreversible electorate lock, sealed key generation and ordered rounds', async () => {
  const organizer = randomUUID(); const voters = [randomUUID(), randomUUID()];
  const stream = createPollStream('s'.repeat(64));
  let s = stream.initial(scope);
  assert.throws(() => applyCommand(stream, s, 'open', { round: 'pre' }, ctx(organizer)), /round_order/);
  const payload = await stream.prepare('lockElectorate', { principalIds: voters }, s, ctx(organizer));
  s = applyCommand(stream, s, 'lockElectorate', payload, ctx(organizer)).state;
  assert.equal(s.electorate.count, 2); assert.ok(s.electorate.digests.includes(voterDigest(voters[0])));
  assert.equal(JSON.stringify(s.electorate).includes(voters[0]), false);
  assert.equal(stream.redact(s).sealedKey, null);
  assert.throws(() => applyCommand(stream, s, 'lockElectorate', payload, ctx(organizer)), /electorate_locked/);
  for (const [type, round] of [['open', 'pre'], ['close', 'pre'], ['open', 'post'], ['close', 'post']]) s = applyCommand(stream, s, type, { round }, ctx(organizer)).state;
  assert.equal(s.status, 'closed');
  assert.throws(() => applyCommand(stream, s, 'open', { round: 'post' }, ctx(organizer)), /round_order/);
});

test('E-22 outcome: paired-cohort swing with exact integers, ties and advancement', () => {
  const pairs = [['for', 'for'], ['against', 'for'], ['undecided', 'for'], ['against', 'against'], ['undecided', 'against'], ['for', 'undecided']].map(([pre, post]) => ({ pre, post }));
  const v = audienceVerdict(matrixFromPairs(pairs));
  assert.deepEqual(v.preCounts, { for: 2, against: 2, undecided: 2 }); assert.deepEqual(v.postCounts, { for: 3, against: 2, undecided: 1 });
  assert.deepEqual(v.gain, { for: 1, against: 0 }); assert.equal(v.decision, 'for');
  assert.equal(audienceVerdict(matrixFromPairs([])).decision, 'inconclusive');
  assert.equal(audienceVerdict(matrixFromPairs([{ pre: 'undecided', post: 'for' }, { pre: 'undecided', post: 'against' }])).decision, 'tie');
  assert.deepEqual(advancement('tie', 'against', 'judges'), { selectedSide: 'against', reason: 'judges-tiebreak' });
  assert.deepEqual(advancement('tie', 'tie', 'judges'), { selectedSide: null, reason: 'review' });
  assert.deepEqual(advancement('for', 'against', 'judges'), { selectedSide: 'for', reason: 'audience' });
  assert.equal(compareRational({ numerator: 1, denominator: 3 }, { numerator: 333333333, denominator: 1000000000 }), 1);
  assert.throws(() => addMatrices({ for: { for: -1, against: 0, undecided: 0 }, against: { for: 0, against: 0, undecided: 0 }, undecided: { for: 0, against: 0, undecided: 0 } }), /Invalid count/);
});

test('E-23 paper fallback: two distinct tellers must agree; mismatches are disputed; stock bounds counts', () => {
  const t1 = randomUUID(); const t2 = randomUUID(); const batch = randomUUID();
  const m = (n) => ({ for: { for: n, against: 0, undecided: 0 }, against: { for: 1, against: 2, undecided: 0 }, undecided: { for: 0, against: 0, undecided: 0 } });
  let s = applyCommand(paperStream, paperStream.initial(scope), 'declareBatch', { batchId: batch, label: 'Hall A box 1', issued: 10 }, ctx(t1)).state;
  s = applyCommand(paperStream, s, 'enterCount', { batchId: batch, matrix: m(3), spoiled: 1 }, ctx(t1)).state;
  assert.throws(() => applyCommand(paperStream, s, 'enterCount', { batchId: batch, matrix: m(3), spoiled: 1 }, ctx(t1)), /teller_already_entered/);
  const disputed = applyCommand(paperStream, s, 'enterCount', { batchId: batch, matrix: m(4), spoiled: 1 }, ctx(t2)).state;
  assert.equal(disputed.batches[0].status, 'disputed'); assert.equal(reconciledMatrix(disputed).for.for, 0);
  const ok = applyCommand(paperStream, s, 'enterCount', { batchId: batch, matrix: m(3), spoiled: 1 }, ctx(t2)).state;
  assert.equal(ok.batches[0].status, 'reconciled'); assert.equal(reconciledMatrix(ok).for.for, 3);
  assert.throws(() => applyCommand(paperStream, s, 'enterCount', { batchId: batch, matrix: m(30), spoiled: 0 }, ctx(t2)), /exceeds_issued_stock/);
  const results = applyCommand(resultsStream, resultsStream.initial(scope), 'computeAudience', { pollId: randomUUID(), electronic: m(0), paper: reconciledMatrix(ok), electorateDigest: 'a'.repeat(64), issued: 9 }, ctx(t1)).state;
  assert.equal(results.audience.verdict.cohort, 9); assert.equal(results.audience.verdict.decision, 'for');
});

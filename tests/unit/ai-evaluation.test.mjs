import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyCommand } from '../../dist/packages/competition/src/operations/stream.js';
import { heuristicBaseline, unconfiguredModelProvider } from '../../dist/packages/competition/src/ai/analysis.js';
import { aiScorecard, reproduce } from '../../dist/packages/competition/src/ai/scorecard.js';
import { evaluate, thresholdFailures, annotatorKappa } from '../../dist/packages/competition/src/ai/evaluation.js';
import { datasetStream, clearedItems, qualificationStream, allowedMode, aiReviewStream } from '../../dist/packages/competition/src/ai/streams.js';
import { resultsStream, effectiveJudges } from '../../dist/packages/competition/src/operations/results.js';
import { matrixFromPairs } from '../../dist/packages/competition/src/operations/outcome.js';

const scope = { tenantId: randomUUID(), eventId: randomUUID(), entityId: randomUUID() };
const ctx = (actor, n = 0) => ({ actor, now: new Date(Date.UTC(2027, 5, 1, 10, n)).toISOString(), scope });
const go = (s, st, type, p, actor, n) => applyCommand(s, st, type, p, ctx(actor, n)).state;
const rubric = [{ code: 'argument', label: 'Argument', weightBps: 6000, minimum: 0, maximum: 10 }, { code: 'delivery', label: 'Delivery', weightBps: 4000, minimum: 1, maximum: 5 }];
const segments = [
  { side: 'for', text: 'Thank you. According to a 2024 study, 40 percent of commuters would switch, because transit is faster.' },
  { side: 'against', text: 'My opponent is a liar. Either we ban cars or we lose the city. Think of the children!' },
  { side: 'for', text: 'In response to that, I concede the point on cost, but the data from Vienna show savings.' },
];

test('E-39/E-40 baseline analysis is labelled, deterministic and produces reproducible hash-bound artifacts', async () => {
  const a = await heuristicBaseline.analyze(segments);
  assert.deepEqual(a.against.fallacies.map((f) => f.label).sort(), ['ad-hominem', 'appeal-to-emotion', 'false-dilemma']);
  assert.ok(a.for.virtues.map((v) => v.label).includes('evidence-cited'));
  const artifact = await aiScorecard(heuristicBaseline, rubric, segments);
  assert.equal(artifact.kind, 'heuristic-baseline'); assert.equal(artifact.qualified, false); assert.equal(artifact.decision, 'for');
  assert.equal(await reproduce(heuristicBaseline, rubric, segments, artifact), true);
  assert.equal(await reproduce(heuristicBaseline, rubric, [...segments, { side: 'for', text: 'x' }], artifact), false);
  await assert.rejects(unconfiguredModelProvider.analyze(segments), /analysis_provider_unconfigured/);
});

test('E-42 evaluation metrics and thresholds; the baseline cannot be certified on a small or poor dataset', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ itemId: String(i), human: i % 2 ? 'for' : 'against', ai: i % 3 ? 'for' : 'against', humanFallacies: ['ad-hominem'], aiFallacies: i % 2 ? ['ad-hominem'] : ['straw-man'] }));
  const m = evaluate(rows);
  assert.ok(m.accuracyBps < 8000); assert.ok(thresholdFailures(m).includes('accuracy'));
  const perfect = evaluate(rows.map((r) => ({ ...r, ai: r.human, aiFallacies: r.humanFallacies })));
  assert.equal(perfect.accuracyBps, 10000); assert.equal(perfect.kappaBps, 10000); assert.deepEqual(thresholdFailures(perfect), []);
  assert.deepEqual(thresholdFailures(evaluate(rows.slice(0, 10).map((r) => ({ ...r, ai: r.human, aiFallacies: r.humanFallacies })))), ['insufficient_items']);
  assert.equal(annotatorKappa([['for', 'for'], ['against', 'against']]), 10000);
});

test('E-38 dataset: every consent required, withdrawal excludes, independent annotation and adjudication', () => {
  const [org, d1, d2, a1, a2, adj] = Array.from({ length: 6 }, randomUUID); const item = randomUUID();
  let s = go(datasetStream, datasetStream.initial(scope), 'register', { itemId: item, description: 'Synthetic debate transcript', requiredConsents: [d1, d2], aiDecision: 'for', aiFallacies: [] }, org);
  assert.throws(() => go(datasetStream, s, 'annotate', { itemId: item, labels: { decision: 'for', fallacies: [] } }, a1), /rights_not_cleared/);
  s = go(datasetStream, s, 'consent', { itemId: item, granted: true }, d1);
  assert.equal(s.items[0].status, 'pending-rights');
  const withdrawn = go(datasetStream, s, 'consent', { itemId: item, granted: false }, d1);
  assert.equal(withdrawn.items[0].status, 'excluded');
  s = go(datasetStream, s, 'consent', { itemId: item, granted: true }, d2);
  assert.equal(s.items[0].status, 'cleared');
  assert.throws(() => go(datasetStream, s, 'annotate', { itemId: item, labels: { decision: 'for', fallacies: [] } }, d1), /participant_cannot_annotate/);
  s = go(datasetStream, s, 'annotate', { itemId: item, labels: { decision: 'for', fallacies: ['straw-man'] } }, a1);
  assert.throws(() => go(datasetStream, s, 'adjudicate', { itemId: item, labels: { decision: 'for', fallacies: [] } }, adj), /two_annotations_required/);
  s = go(datasetStream, s, 'annotate', { itemId: item, labels: { decision: 'against', fallacies: [] } }, a2);
  assert.throws(() => go(datasetStream, s, 'adjudicate', { itemId: item, labels: { decision: 'for', fallacies: [] } }, a1), /independent/);
  s = go(datasetStream, s, 'adjudicate', { itemId: item, labels: { decision: 'for', fallacies: [] } }, adj);
  assert.equal(clearedItems(s).length, 1);
  assert.deepEqual(datasetStream.view(s, d1).items[0].status, 'cleared'); assert.equal(datasetStream.view(s, a1).items.length, 0);
});

test('E-42/E-43/E-48..E-50 certification and staged rollout fail closed', () => {
  const [o1, o2] = [randomUUID(), randomUUID()];
  const poor = { n: 60, accuracyBps: 5500, kappaBps: 1000, sideBiasBps: 2000, fallacyPrecisionBps: 3000, fallacyRecallBps: 3000 };
  let q = go(qualificationStream, qualificationStream.initial(scope), 'recordEvaluation', { provider: 'heuristic-baseline', model: 'lde-lexical-rules', version: '1', metrics: poor }, o1);
  assert.throws(() => go(qualificationStream, q, 'sign', { outputConfirmed: true }, o1), /thresholds_not_met/);
  q = go(qualificationStream, q, 'setStage', { stage: 'shadow', reason: 'Shadow comparison only' }, o1);
  q = go(qualificationStream, q, 'setStage', { stage: 'advisory', reason: 'Advisory after judges submit' }, o1);
  assert.throws(() => go(qualificationStream, q, 'setStage', { stage: 'hybrid', reason: 'Attempt without certification' }, o1), /certification_required/);
  assert.equal(allowedMode(q, 'advisory'), true); assert.equal(allowedMode(q, 'hybrid'), false); assert.equal(allowedMode(q, 'ai'), false);
  const good = { n: 80, accuracyBps: 9000, kappaBps: 8000, sideBiasBps: 200, fallacyPrecisionBps: 7000, fallacyRecallBps: 7000 };
  let c = go(qualificationStream, q, 'recordEvaluation', { provider: 'p', model: 'm', version: '1', metrics: good }, o1);
  c = go(qualificationStream, c, 'sign', { outputConfirmed: true }, o1);
  assert.equal(c.certified, false);
  c = go(qualificationStream, c, 'sign', { outputConfirmed: true }, o2);
  assert.equal(c.certified, true);
  assert.equal(c.stage, 'shadow'); // a new evaluation restarts the rollout at shadow
  assert.throws(() => go(qualificationStream, c, 'setStage', { stage: 'hybrid', reason: 'Skipping advisory stage' }, o1), /one_at_a_time/);
  c = go(qualificationStream, c, 'setStage', { stage: 'advisory', reason: 'Advisory after recertification' }, o1);
  c = go(qualificationStream, c, 'setStage', { stage: 'hybrid', reason: 'Controlled hybrid rollout' }, o1);
  assert.equal(allowedMode(c, 'hybrid'), true);
  c = go(qualificationStream, c, 'revoke', { reason: 'Drift detected in field validation' }, o2);
  assert.equal(allowedMode(c, 'hybrid'), false); assert.equal(c.stage, 'advisory');
});

test('E-41 advisory output is withheld until all judges submit; E-43 hybrid/AI modes combine only when qualified', async () => {
  const v = randomUUID();
  const artifact = await aiScorecard(heuristicBaseline, rubric, segments);
  let r = go(aiReviewStream, aiReviewStream.initial(scope), 'recordArtifact', { panelId: randomUUID(), artifact }, v);
  assert.equal(aiReviewStream.view(r, v).artifact, null);
  assert.throws(() => go(aiReviewStream, r, 'release', { humanDecision: 'against', allSubmitted: false }, v), /judges_still_scoring/);
  r = go(aiReviewStream, r, 'release', { humanDecision: 'against', allSubmitted: true }, v);
  assert.equal(aiReviewStream.view(r, v).divergence, true);
  const panel = { decision: 'against', judges: [{ decision: 'against' }, { decision: 'for' }, { decision: 'for' }].map((j, i) => ({ ...j, judgeId: String(i) })) };
  assert.equal(effectiveJudges(panel, { mode: 'hybrid', decision: 'for' }), 'for');
  assert.equal(effectiveJudges(panel, { mode: 'advisory', decision: 'for' }), 'against');
  assert.equal(effectiveJudges(panel, { mode: 'ai', decision: 'tie' }), 'tie');
  const base = go(resultsStream, resultsStream.initial(scope), 'computeAudience', { pollId: randomUUID(), electronic: matrixFromPairs([{ pre: 'for', post: 'for' }]), paper: matrixFromPairs([]), electorateDigest: 'a'.repeat(64), issued: 1 }, v);
  assert.throws(() => go(resultsStream, base, 'recordAiJudge', { mode: 'hybrid', decision: 'for', outputHash: artifact.outputHash, provider: 'p', qualified: false }, v), /not_qualified/);
});

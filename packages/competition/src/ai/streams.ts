import { bool, deepFreeze, fail, list, oneOf, record, str, uuid, type Context, type Queryable } from '../operations/common.js';
import { defineStream } from '../operations/stream.js';
import type { PanelState } from '../operations/panel.js';
import type { ResultsState } from '../operations/results.js';
import { FALLACIES, heuristicBaseline, type AnalysisProvider, type Segment } from './analysis.js';
import { aiScorecard, type AiArtifact } from './scorecard.js';
import { evaluate, thresholdFailures, type Labelled, type Metrics } from './evaluation.js';

async function latest<T>(db: Queryable, scope: Context['scope'], stream: string, action: string, entity: string): Promise<T> {
  const row = (await db.query<{ result: { records: { snapshot: { data: { state: T } } }[] } }>('SELECT lde_competition.operation_records($1,$2,$3,$4,$5,$6) AS result', [scope?.tenantId, scope?.eventId, stream, action, entity, 2147483647])).rows[0]?.result;
  return row?.records[0]?.snapshot.data.state ?? fail(`unknown_${stream}`);
}

/* ---------- E-38 rights-cleared evaluation data and annotation ---------- */
export type Labels = Readonly<{ decision: 'for' | 'against' | 'tie'; fallacies: readonly string[] }>;
export type DataItem = Readonly<{ itemId: string; description: string; requiredConsents: readonly string[]; consents: readonly string[]; status: 'pending-rights' | 'cleared' | 'excluded';
  annotations: readonly Readonly<{ annotator: string; labels: Labels; at: string }>[]; adjudicated: Labels | null; adjudicator: string | null; aiDecision: Labels['decision'] | null; aiFallacies: readonly string[] }>;
export type DatasetState = Readonly<{ items: readonly DataItem[] }>;
const labels = (v: unknown): Labels => { const p = record(v, ['decision', 'fallacies'], 'labels'); const f = list(p.fallacies, (x) => oneOf(x, FALLACIES, 'fallacy'), 'fallacies', 0, 8); return { decision: oneOf(p.decision, ['for', 'against', 'tie'] as const, 'decision'), fallacies: [...new Set(f)].sort() }; };
/** Only items with every required consent, two independent annotations and an adjudication are usable. */
export function clearedItems(state: DatasetState): readonly DataItem[] { return state.items.filter((i) => i.status === 'cleared' && i.adjudicated !== null); }
export function applyDataset(state: DatasetState, type: string, input: unknown, context: Context): DatasetState {
  const find = (id: unknown) => state.items.find((i) => i.itemId === id) ?? fail('unknown_item');
  const put = (i: DataItem, next: Partial<DataItem>) => deepFreeze({ items: state.items.map((x) => x === i ? { ...i, ...next } : x) });
  switch (type) {
    case 'register': {
      const p = record(input, ['itemId', 'description', 'requiredConsents', 'aiDecision', 'aiFallacies']);
      const item: DataItem = { itemId: uuid(p.itemId, 'item'), description: str(p.description, 'description', 5, 500), requiredConsents: [...new Set(list(p.requiredConsents, (x) => uuid(x, 'principal'), 'consents', 1, 20))],
        consents: [], status: 'pending-rights', annotations: [], adjudicated: null, adjudicator: null,
        aiDecision: p.aiDecision === null ? null : oneOf(p.aiDecision, ['for', 'against', 'tie'] as const, 'decision'), aiFallacies: list(p.aiFallacies, (x) => oneOf(x, FALLACIES, 'fallacy'), 'fallacies', 0, 8) };
      if (state.items.some((i) => i.itemId === item.itemId)) fail('duplicate_item', 409);
      if (state.items.length >= 150) fail('dataset_full');
      return deepFreeze({ items: [...state.items, item] });
    }
    case 'consent': {
      const p = record(input, ['itemId', 'granted']); const i = find(p.itemId);
      if (!i.requiredConsents.includes(context.actor)) fail('consent_not_requested', 403);
      const consents = bool(p.granted, 'granted') ? [...new Set([...i.consents, context.actor])] : i.consents.filter((c) => c !== context.actor);
      // Withdrawal excludes the item permanently from future evaluation.
      const status = !bool(p.granted, 'granted') ? 'excluded' : i.status === 'excluded' ? 'excluded' : i.requiredConsents.every((c) => consents.includes(c)) ? 'cleared' : 'pending-rights';
      return put(i, { consents, status });
    }
    case 'exclude': { const p = record(input, ['itemId', 'reason']); str(p.reason, 'reason', 5, 300); return put(find(p.itemId), { status: 'excluded' }); }
    case 'annotate': {
      const p = record(input, ['itemId', 'labels']); const i = find(p.itemId);
      if (i.status !== 'cleared') fail('rights_not_cleared');
      if (i.requiredConsents.includes(context.actor)) fail('participant_cannot_annotate', 403);
      if (i.annotations.some((a) => a.annotator === context.actor)) fail('already_annotated', 409);
      return put(i, { annotations: [...i.annotations, { annotator: context.actor, labels: labels(p.labels), at: context.now }].slice(-5) });
    }
    case 'adjudicate': {
      const p = record(input, ['itemId', 'labels']); const i = find(p.itemId);
      if (i.annotations.length < 2) fail('two_annotations_required');
      if (i.annotations.some((a) => a.annotator === context.actor)) fail('adjudicator_must_be_independent', 403);
      return put(i, { adjudicated: labels(p.labels), adjudicator: context.actor });
    }
    default: return fail('unknown_command', 400);
  }
}
const dcmd = (type: string, action: 'event.manage' | 'participant.self' | 'result.verify' | 'dispute.review') => ({ action, apply: (s: DatasetState, p: unknown, c: Context) => applyDataset(s, type, p, c) });
export const datasetStream = defineStream<DatasetState>({ name: 'evaluation-data', readAction: 'result.verify', initial: () => deepFreeze({ items: [] }),
  commands: { register: dcmd('register', 'event.manage'), consent: dcmd('consent', 'participant.self'), exclude: dcmd('exclude', 'event.manage'), annotate: dcmd('annotate', 'result.verify'), adjudicate: dcmd('adjudicate', 'dispute.review') },
  view: (state, actor) => ({ items: state.items.filter((i) => i.requiredConsents.includes(actor)).map((i) => ({ itemId: i.itemId, description: i.description, consented: i.consents.includes(actor), status: i.status })) }) });

/* ---------- E-42/E-43/E-48..E-50 qualification, certification and staged rollout ---------- */
export const STAGES = ['none', 'shadow', 'advisory', 'hybrid', 'ai'] as const;
export type QualificationState = Readonly<{ provider: string | null; model: string | null; version: string | null; metrics: Metrics | null; failures: readonly string[];
  signatures: readonly Readonly<{ by: string; at: string }>[]; certified: boolean; stage: typeof STAGES[number]; stageHistory: readonly Readonly<{ stage: string; by: string; at: string; reason: string }>[]; revokedReason: string | null }>;
export function initialQualification(): QualificationState { return deepFreeze({ provider: null, model: null, version: null, metrics: null, failures: [], signatures: [], certified: false, stage: 'none', stageHistory: [], revokedReason: null }); }
/** E-43 gate: which execution modes the current qualification allows. Fails closed. */
export function allowedMode(q: QualificationState, mode: 'human' | 'advisory' | 'hybrid' | 'ai'): boolean {
  if (mode === 'human') return true;
  if (!q.certified) return mode === 'advisory' && STAGES.indexOf(q.stage) >= STAGES.indexOf('advisory');
  return STAGES.indexOf(q.stage) >= STAGES.indexOf(mode === 'advisory' ? 'advisory' : mode);
}
export function applyQualification(state: QualificationState, type: string, input: unknown, context: Context): QualificationState {
  switch (type) {
    case 'recordEvaluation': {
      const p = record(input, ['provider', 'model', 'version', 'metrics']);
      const metrics = p.metrics as Metrics;
      return deepFreeze({ ...state, provider: str(p.provider, 'provider', 1, 80), model: str(p.model, 'model', 1, 120), version: str(p.version, 'version', 1, 40), metrics, failures: thresholdFailures(metrics), signatures: [], certified: false, revokedReason: null,
        stage: state.stage === 'none' ? 'none' : 'shadow' });
    }
    case 'sign': {
      const p = record(input, ['outputConfirmed']); if (!bool(p.outputConfirmed, 'confirm')) fail('confirmation_required', 400);
      if (!state.metrics) fail('no_evaluation');
      if (state.failures.length) fail(`thresholds_not_met:${state.failures.join(',')}`);
      if (state.signatures.some((s) => s.by === context.actor)) fail('already_signed', 409);
      const signatures = [...state.signatures, { by: context.actor, at: context.now }];
      return deepFreeze({ ...state, signatures, certified: signatures.length >= 2 });
    }
    case 'setStage': {
      const p = record(input, ['stage', 'reason']); const stage = oneOf(p.stage, STAGES, 'stage');
      const rank = STAGES.indexOf(stage); const current = STAGES.indexOf(state.stage);
      if (rank > current + 1) fail('stages_must_advance_one_at_a_time');
      if (rank >= STAGES.indexOf('hybrid') && !state.certified) fail('certification_required');
      if (rank >= STAGES.indexOf('advisory') && rank > current && state.stageHistory.filter((h) => h.stage === STAGES[current]).length === 0 && current > 0) fail('prior_stage_not_recorded');
      return deepFreeze({ ...state, stage, stageHistory: [...state.stageHistory, { stage, by: context.actor, at: context.now, reason: str(p.reason, 'reason', 10, 500) }].slice(-30) });
    }
    case 'revoke': {
      const reason = str(record(input, ['reason']).reason, 'reason', 10, 500);
      return deepFreeze({ ...state, certified: false, signatures: [], stage: STAGES.indexOf(state.stage) > STAGES.indexOf('advisory') ? 'advisory' : state.stage, revokedReason: reason });
    }
    default: return fail('unknown_command', 400);
  }
}
export function createQualificationStream(provider: AnalysisProvider = heuristicBaseline) {
  const q = (type: string, action: 'result.verify' | 'dispute.review') => ({ action, apply: (s: QualificationState, p: unknown, c: Context) => applyQualification(s, type, p, c) });
  return defineStream<QualificationState>({ name: 'qualification', readAction: 'event.read', initial: initialQualification,
    commands: { recordEvaluation: q('recordEvaluation', 'result.verify'), sign: q('sign', 'dispute.review'), setStage: q('setStage', 'dispute.review'), revoke: q('revoke', 'dispute.review') },
    // The evaluation is computed server-side from the cleared, adjudicated dataset; callers send only its id.
    prepare: async (type, payload, _state, context, db) => {
      if (type !== 'recordEvaluation') return payload;
      const p = record(payload, ['datasetId']);
      const dataset = await latest<DatasetState>(db, context.scope, 'evaluation-data', 'result.verify', uuid(p.datasetId, 'dataset'));
      const rows: Labelled[] = clearedItems(dataset).filter((i) => i.aiDecision !== null).map((i) => ({ itemId: i.itemId, human: i.adjudicated?.decision ?? 'tie', ai: i.aiDecision ?? 'tie', humanFallacies: i.adjudicated?.fallacies ?? [], aiFallacies: i.aiFallacies }));
      return { provider: provider.id, model: provider.model, version: provider.version, metrics: evaluate(rows) };
    } });
}
export const qualificationStream = createQualificationStream();

/* ---------- E-40/E-41 AI scorecard artifacts and anti-anchoring release to judges ---------- */
export type AiReviewState = Readonly<{ artifact: AiArtifact | null; panelId: string | null; releasedToJudges: boolean; humanDecision: string | null; divergence: boolean | null }>;
export function applyAiReview(state: AiReviewState, type: string, input: unknown, _context: Context): AiReviewState {
  switch (type) {
    case 'recordArtifact': { const p = record(input, ['panelId', 'artifact']); if (state.releasedToJudges) fail('already_released', 409); return deepFreeze({ ...state, panelId: uuid(p.panelId, 'panel'), artifact: p.artifact as AiArtifact }); }
    case 'release': {
      const p = record(input, ['humanDecision', 'allSubmitted']);
      if (!state.artifact) fail('no_artifact');
      // Advisory output is shown only after every seated judge has submitted, so it cannot anchor scoring.
      if (p.allSubmitted !== true) fail('judges_still_scoring', 409);
      const human = oneOf(p.humanDecision, ['for', 'against', 'tie', 'inconclusive'] as const, 'decision');
      return deepFreeze({ ...state, releasedToJudges: true, humanDecision: human, divergence: human !== state.artifact.decision });
    }
    default: return fail('unknown_command', 400);
  }
}
export function createAiReviewStream(provider: AnalysisProvider = heuristicBaseline) {
  const a = (type: string) => ({ action: 'result.verify' as const, apply: (s: AiReviewState, p: unknown, c: Context) => applyAiReview(s, type, p, c) });
  return defineStream<AiReviewState>({ name: 'ai-review', readAction: 'result.verify', initial: () => deepFreeze({ artifact: null, panelId: null, releasedToJudges: false, humanDecision: null, divergence: null }),
    commands: { recordArtifact: a('recordArtifact'), release: a('release') },
    prepare: async (type, payload, state, context, db) => {
      if (type === 'recordArtifact') {
        const p = record(payload, ['panelId', 'transcriptId', 'sides']);
        const panel = await latest<PanelState>(db, context.scope, 'panel', 'event.read', uuid(p.panelId, 'panel'));
        const transcript = await latest<{ segments: { speakerId: string | null; text: string }[] }>(db, context.scope, 'transcript', 'event.read', uuid(p.transcriptId, 'transcript'));
        const sides = record(p.sides, ['for', 'against'], 'sides');
        const forIds = list(sides.for, (x) => uuid(x, 'principal'), 'for', 1, 8); const againstIds = list(sides.against, (x) => uuid(x, 'principal'), 'against', 1, 8);
        const segments: Segment[] = transcript.segments.filter((s) => s.speakerId).map((s) => ({ side: forIds.includes(s.speakerId ?? '') ? 'for' : againstIds.includes(s.speakerId ?? '') ? 'against' : null, text: s.text })).filter((s): s is Segment => s.side !== null);
        if (segments.length === 0) fail('no_attributed_transcript');
        return { panelId: p.panelId, artifact: await aiScorecard(provider, panel.rubric, segments) };
      }
      if (type === 'release') {
        const p = record(payload, ['resultsId']);
        const results = await latest<ResultsState>(db, context.scope, 'results', 'result.verify', uuid(p.resultsId, 'results'));
        const verdict = results.judges?.verdict;
        if (!verdict || results.judges?.panelId !== state.panelId) fail('judges_not_recorded');
        return { humanDecision: verdict.decision, allSubmitted: verdict.submitted >= verdict.seats };
      }
      return payload;
    },
    view: (state) => (state.releasedToJudges ? { artifact: state.artifact, divergence: state.divergence } : { artifact: null, releasedToJudges: false }) });
}
export const aiReviewStream = createAiReviewStream();

import { bool, deepFreeze, fail, hashOf, record, str, uuid, type Context, type Queryable } from './common.js';
import { addMatrices, advancement, audienceVerdict, CHOICES, emptyMatrix, type AudienceVerdict, type TransitionMatrix } from './outcome.js';
import { reconciledMatrix, type PaperState } from './paper.js';
import { parseTally } from './ballots.js';
import { judgeDecision, panelVerdict, type PanelVerdict } from './judging.js';
import { loadPanel, type ScorecardState } from './scorecard.js';
import { defineStream } from './stream.js';

/** E-22 audience outcome and E-26 result verification, certification, announcement and correction. */
export type AudienceResult = Readonly<{ pollId: string; electronic: TransitionMatrix; paper: TransitionMatrix; electorateDigest: string; issued: number; verdict: AudienceVerdict; computedAt: string; computedBy: string }>;
export type JudgesResult = Readonly<{ panelId: string; verdict: PanelVerdict; recused: number; computedAt: string; computedBy: string }>;
export type ResultsState = Readonly<{
  version: number; audience: AudienceResult | null; judges: JudgesResult | null;
  advancement: Readonly<{ selectedSide: 'for' | 'against' | null; reason: string }> | null; resultsHash: string | null;
  verifications: readonly Readonly<{ by: string; at: string; hash: string }>[];
  status: 'computing' | 'certified' | 'announced'; certifiedAt: string | null; certifiedBy: string | null; announcedAt: string | null;
  corrections: readonly Readonly<{ version: number; reason: string; by: string; at: string; previousHash: string | null }>[];
}>;
export function initialResults(): ResultsState {
  return deepFreeze({ version: 1, audience: null, judges: null, advancement: null, resultsHash: null, verifications: [], status: 'computing', certifiedAt: null, certifiedBy: null, announcedAt: null, corrections: [] });
}
function matrix(value: unknown): TransitionMatrix {
  const m = record(value, [...CHOICES], 'matrix'); const out = emptyMatrix() as Record<string, Record<string, number>>;
  for (const a of CHOICES) { const row = record(m[a], [...CHOICES], 'matrix'); for (const b of CHOICES) { const n = row[b]; if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) fail('invalid_count', 400); (out[a] as Record<string, number>)[b] = n; } }
  return out as TransitionMatrix;
}
/** Any input change resets verification; hash covers the exact inputs and verdicts. */
function recompute(state: ResultsState, audienceTie: 'judges' | 'review' | 'rematch' = 'judges'): ResultsState {
  const adv = state.audience ? advancement(state.audience.verdict.decision, state.judges?.verdict.decision ?? null, audienceTie) : null;
  const resultsHash = state.audience || state.judges ? hashOf({ version: state.version, audience: state.audience, judges: state.judges, advancement: adv }) : null;
  return deepFreeze({ ...state, advancement: adv, resultsHash, verifications: [] });
}
function computing(state: ResultsState): ResultsState { if (state.status !== 'computing') fail('results_certified', 409); return state; }

export function applyResults(state: ResultsState, type: string, input: unknown, context: Context): ResultsState {
  switch (type) {
    case 'computeAudience': {
      const p = record(input, ['pollId', 'electronic', 'paper', 'electorateDigest', 'issued']);
      const electronic = matrix(p.electronic); const paper = matrix(p.paper);
      if (typeof p.electorateDigest !== 'string' || typeof p.issued !== 'number') fail('invalid_tally', 400);
      return recompute({ ...computing(state), audience: { pollId: uuid(p.pollId, 'poll'), electronic, paper, electorateDigest: p.electorateDigest, issued: p.issued,
        verdict: audienceVerdict(addMatrices(electronic, paper)), computedAt: context.now, computedBy: context.actor } });
    }
    case 'recordJudges': {
      const p = record(input, ['panelId', 'verdict', 'recused']);
      return recompute({ ...computing(state), judges: { panelId: uuid(p.panelId, 'panel'), verdict: p.verdict as PanelVerdict, recused: Number(p.recused), computedAt: context.now, computedBy: context.actor } });
    }
    case 'verify': {
      const p = record(input, ['resultsHash', 'confirm']);
      computing(state);
      if (!state.resultsHash || p.resultsHash !== state.resultsHash) fail('results_changed', 409);
      if (!bool(p.confirm, 'confirm')) fail('confirmation_required', 400);
      if (state.verifications.some((v) => v.by === context.actor)) fail('already_verified', 409);
      return deepFreeze({ ...state, verifications: [...state.verifications, { by: context.actor, at: context.now, hash: state.resultsHash }] });
    }
    case 'certify': {
      const p = record(input, ['resultsHash']);
      computing(state);
      if (!state.audience || state.resultsHash !== p.resultsHash) fail('results_changed', 409);
      if (state.audience.verdict.decision === 'inconclusive' || state.advancement?.selectedSide === null) fail('held_for_review');
      const verifiers = new Set(state.verifications.filter((v) => v.hash === state.resultsHash).map((v) => v.by));
      if (verifiers.size < 2) fail('two_verifications_required');
      if (verifiers.has(context.actor) && verifiers.size < 3) fail('certifier_must_be_independent_of_two_verifiers');
      return deepFreeze({ ...state, status: 'certified', certifiedAt: context.now, certifiedBy: context.actor });
    }
    case 'announce': record(input, []); if (state.status !== 'certified') fail('not_certified', 409); return deepFreeze({ ...state, status: 'announced', announcedAt: context.now });
    case 'reopen': {
      const reason = str(record(input, ['reason']).reason, 'reason', 10, 1000);
      if (state.status === 'computing') fail('not_certified', 409);
      return recompute({ ...state, version: state.version + 1, status: 'computing', certifiedAt: null, certifiedBy: null, announcedAt: null,
        corrections: [...state.corrections, { version: state.version, reason, by: context.actor, at: context.now, previousHash: state.resultsHash }] });
    }
    default: return fail('unknown_command', 400);
  }
}
/** Tallies and scorecards are read inside the verifier's own transaction; callers supply only ids. */
export async function prepareResults(type: string, payload: unknown, db: Queryable, scope: Context['scope']): Promise<unknown> {
  if (type === 'computeAudience') {
    const p = record(payload, ['pollId', 'paperEntityId']);
    const pollId = uuid(p.pollId, 'poll');
    const tally = parseTally((await db.query<{ result: unknown }>('SELECT lde_competition.ballot_tally($1,$2,$3,false) AS result', [scope?.tenantId, scope?.eventId, pollId])).rows[0]?.result);
    let paper = emptyMatrix();
    if (p.paperEntityId !== null) {
      const row = (await db.query<{ result: { current: { snapshot: { data: { state: PaperState } } } | null } }>('SELECT lde_competition.operation_state($1,$2,$3,$4,$5) AS result',
        [scope?.tenantId, scope?.eventId, 'paper', 'result.verify', uuid(p.paperEntityId, 'paper')])).rows[0]?.result;
      paper = row?.current ? reconciledMatrix(row.current.snapshot.data.state) : fail('unknown_paper_record');
    }
    return { pollId, electronic: tally.paired, paper, electorateDigest: tally.electorateDigest, issued: tally.issued };
  }
  if (type === 'recordJudges') {
    const p = record(payload, ['panelId']);
    const panelId = uuid(p.panelId, 'panel');
    const panel = await loadPanel(db, scope, panelId);
    if (panel.status !== 'closed') fail('panel_not_closed', 409);
    const rows = (await db.query<{ result: { records: { snapshot: { data: { state: ScorecardState } } }[] } }>('SELECT lde_competition.operation_records($1,$2,$3,$4,NULL,$5) AS result',
      [scope?.tenantId, scope?.eventId, 'scorecard', 'result.verify', 2147483647])).rows[0]?.result.records ?? [];
    const cards = rows.map((r) => r.snapshot.data.state).filter((c) => c.panelId === panelId && c.judgeId !== null && panel.judges.includes(c.judgeId));
    const submitted = cards.filter((c) => c.status === 'submitted');
    if (new Set(submitted.map((c) => c.judgeId)).size !== submitted.length) fail('duplicate_scorecards');
    const decisions = submitted.map((c) => judgeDecision(c.judgeId ?? '', panel.rubric, c.entries, c.adjustments));
    return { panelId, verdict: panelVerdict(decisions, panel.seats, panel.aggregation), recused: cards.filter((c) => c.status === 'recused').length };
  }
  return payload;
}
const cmd = (type: string, action: 'result.verify' | 'result.publish') => ({ action, apply: (s: ResultsState, p: unknown, c: Context) => applyResults(s, type, p, c) });
export const resultsStream = defineStream<ResultsState>({
  name: 'results', readAction: 'result.verify', initial: initialResults,
  commands: { computeAudience: cmd('computeAudience', 'result.verify'), recordJudges: cmd('recordJudges', 'result.verify'), verify: cmd('verify', 'result.verify'),
    certify: cmd('certify', 'result.publish'), announce: cmd('announce', 'result.publish'), reopen: cmd('reopen', 'result.publish') },
  prepare: (type, payload, _state, context, db) => prepareResults(type, payload, db, context.scope),
});

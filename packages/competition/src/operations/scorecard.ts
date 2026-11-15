import { deepFreeze, fail, int, list, oneOf, record, str, uuid, type Context, type Queryable } from './common.js';
import { adjustmentProblems, rubricProblems, type Adjustment, type CardEntries } from './judging.js';
import type { PanelState } from './panel.js';
import { defineStream } from './stream.js';

/** E-24: a judge's private scorecard. Only its judge writes it; it is sealed on submission. */
export type ScorecardState = Readonly<{ judgeId: string | null; panelId: string | null; status: 'draft' | 'submitted' | 'recused'; entries: CardEntries; adjustments: readonly Adjustment[]; notes: string; submittedAt: string | null; reason: string | null }>;
export function initialScorecard(): ScorecardState { return deepFreeze({ judgeId: null, panelId: null, status: 'draft', entries: { for: {}, against: {} }, adjustments: [], notes: '', submittedAt: null, reason: null }); }

function scores(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_scores', 400);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) { if (!/^[a-z][a-z0-9-]{1,39}$/.test(k)) fail('invalid_scores', 400); out[k] = int(v, 'score', 0, 1000); }
  return out;
}
export function applyScorecard(state: ScorecardState, type: string, input: unknown, context: Context): ScorecardState {
  if (state.judgeId !== null && state.judgeId !== context.actor) fail('not_your_scorecard', 403);
  if (state.status !== 'draft') fail('scorecard_sealed', 409);
  const p = record(input, type === 'recuse' ? ['panel', 'panelId', 'reason'] : ['panel', 'panelId', 'entries', 'adjustments', 'notes']);
  const panel = p.panel as PanelState; const panelId = uuid(p.panelId, 'panel');
  if (state.panelId !== null && state.panelId !== panelId) fail('panel_mismatch', 409);
  if (panel.status !== 'open') fail('panel_not_open', 409);
  if (!panel.judges.includes(context.actor)) fail('not_seated', 403);
  if (type === 'recuse') return deepFreeze({ ...state, judgeId: context.actor, panelId, status: 'recused', reason: str(p.reason, 'reason', 10, 500), submittedAt: context.now });
  const e = record(p.entries, ['for', 'against'], 'entries');
  const entries: CardEntries = { for: scores(e.for), against: scores(e.against) };
  const adjustments = list(p.adjustments, (raw) => { const a = record(raw, ['side', 'kind', 'points', 'finding', 'evidence'], 'adjustment');
    return { side: oneOf(a.side, ['for', 'against'] as const, 'side'), kind: oneOf(a.kind, ['penalty', 'virtue'] as const, 'kind'), points: int(a.points, 'points', 1, 10), finding: str(a.finding, 'finding', 3, 120), evidence: str(a.evidence, 'evidence', 3, 1000) }; }, 'adjustments', 0, 20);
  const problems = adjustmentProblems(adjustments, panel.caps);
  if (type === 'submit') problems.push(...rubricProblems(panel.rubric, entries));
  else for (const side of ['for', 'against'] as const) for (const [code, v] of Object.entries(entries[side])) { const c = panel.rubric.find((x) => x.code === code); if (!c || v < c.minimum || v > c.maximum) problems.push(`invalid_${side}_${code}`); }
  if (problems.length) fail(`scorecard_invalid:${problems.join(',')}`);
  return deepFreeze({ ...state, judgeId: context.actor, panelId, entries, adjustments, notes: typeof p.notes === 'string' ? str(p.notes, 'notes', 0, 4000) : fail('invalid_notes', 400),
    status: type === 'submit' ? 'submitted' : 'draft', submittedAt: type === 'submit' ? context.now : null });
}
/** The panel (rubric, caps, seats) is read server-side; judges cannot supply their own rubric. */
export async function loadPanel(db: Queryable, scope: Context['scope'], panelId: string): Promise<PanelState> {
  const row = (await db.query<{ result: { records: { snapshot: { data: { state: PanelState } } }[] } }>('SELECT lde_competition.operation_records($1,$2,$3,$4,$5,$6) AS result',
    [scope?.tenantId, scope?.eventId, 'panel', 'event.read', panelId, 2147483647])).rows[0]?.result;
  return row?.records[0]?.snapshot.data.state ?? fail('unknown_panel');
}
const cmd = (type: string) => ({ action: 'scorecard.write-own' as const, apply: (s: ScorecardState, p: unknown, c: Context) => applyScorecard(s, type, p, c) });
export const scorecardStream = defineStream<ScorecardState>({
  name: 'scorecard', readAction: 'result.verify', initial: initialScorecard,
  commands: { saveDraft: cmd('saveDraft'), submit: cmd('submit'), recuse: cmd('recuse') },
  prepare: async (_type, payload, _state, context, db) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid_payload', 400);
    const p = record(payload, Object.keys(payload), 'payload');
    if ('panel' in p) fail('invalid_payload', 400);
    return { ...p, panel: await loadPanel(db, context.scope, uuid(p.panelId, 'panel')) };
  },
  view: (state, actor) => state.judgeId === actor || state.judgeId === null ? state : null,
});

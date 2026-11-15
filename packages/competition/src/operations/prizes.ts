import { bool, deepFreeze, fail, hashOf, int, list, oneOf, record, str, uuid, type Context, type Queryable } from './common.js';
import { amount, apportion, lte, sum, type Amount } from './money.js';
import type { ResultsState } from './results.js';
import type { RosterState } from './roster.js';
import { defineStream } from './stream.js';

/** E-27 standard-debate prize ledger (and E-29 placement/special awards recorded on the same ledger). */
export type Obligation = Readonly<{ obligationId: string; recipient: string; amount: Amount; source: 'audience' | 'judges' | 'placement' | 'award'; basis: string; status: 'proposed' | 'approved' | 'held' | 'settled' | 'forfeited'; approvals: readonly string[]; note: string | null }>;
export type PrizeState = Readonly<{ currency: string; exponent: number; budget: Amount; resultsHash: string | null; obligations: readonly Obligation[]; journal: readonly Readonly<{ at: string; by: string; memo: string; obligationId: string | null; delta: Amount; direction: 'commit' | 'release' }>[] }>;
export function initialPrizes(): PrizeState { return deepFreeze({ currency: 'USD', exponent: 2, budget: '0', resultsHash: null, obligations: [], journal: [] }); }
const live = (o: Obligation) => o.status !== 'forfeited';
/** Deterministic obligation id from ledger entity, command time and position. */
export const obligationId = (context: Context, index: number) => hashOf({ entity: context.scope?.entityId ?? null, at: context.now, index }).slice(0, 32);
export function committed(state: PrizeState): Amount { return sum(state.obligations.filter(live).map((o) => o.amount)); }

function addObligations(state: PrizeState, rows: readonly Omit<Obligation, 'status' | 'approvals' | 'note'>[], context: Context, memo: string): PrizeState {
  const total = sum([committed(state), ...rows.map((r) => r.amount)]);
  if (!lte(total, state.budget)) fail('exceeds_prize_budget');
  if (state.obligations.length + rows.length > 200) fail('too_many_obligations');
  return deepFreeze({ ...state, obligations: [...state.obligations, ...rows.map((r) => ({ ...r, status: 'proposed' as const, approvals: [], note: null }))],
    journal: [...state.journal, ...rows.map((r) => ({ at: context.now, by: context.actor, memo, obligationId: r.obligationId, delta: r.amount, direction: 'commit' as const }))].slice(-400) });
}
/** Standard prize: 50% audience share to the audience winner's team, 50% judges share to the judges' winner; ties split. */
export function standardPrizeRows(results: ResultsState, roster: RosterState, pool: Amount, ids: () => string) {
  if (results.status === 'computing' || !results.resultsHash) fail('results_not_certified');
  const team = (side: 'for' | 'against') => roster.teams.find((t) => t.side === side)?.members ?? fail('team_missing');
  const half = apportion(pool, [{ key: 'audience', weight: 1 }, { key: 'judges', weight: 1 }]);
  const rows: Omit<Obligation, 'status' | 'approvals' | 'note'>[] = [];
  const award = (source: 'audience' | 'judges', share: Amount, decision: string | undefined) => {
    const sides = decision === 'for' || decision === 'against' ? [decision] : decision === 'tie' ? ['for', 'against'] as const : [];
    if (sides.length === 0) return;
    const perSide = apportion(share, sides.map((s) => ({ key: s, weight: 1 })));
    for (const side of sides) {
      const split = apportion(perSide[side] ?? '0', team(side as 'for' | 'against').map((m) => ({ key: m, weight: 1 })));
      for (const [recipient, value] of Object.entries(split)) if (value !== '0') rows.push({ obligationId: ids(), recipient, amount: value, source, basis: `${source}:${side}:${results.resultsHash}` });
    }
  };
  award('audience', half.audience ?? '0', results.audience?.verdict.decision);
  award('judges', half.judges ?? '0', results.judges?.verdict.decision);
  return rows;
}

export function applyPrizes(state: PrizeState, type: string, input: unknown, context: Context): PrizeState {
  switch (type) {
    case 'fund': {
      const p = record(input, ['currency', 'exponent', 'budget']);
      if (typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency)) fail('invalid_currency', 400);
      if (state.obligations.length && (p.currency !== state.currency || p.exponent !== state.exponent)) fail('currency_locked', 409);
      const budget = amount(p.budget, 'budget');
      if (!lte(committed(state), budget)) fail('budget_below_commitments');
      return deepFreeze({ ...state, currency: p.currency, exponent: int(p.exponent, 'exponent', 0, 6), budget });
    }
    case 'allocateStandard': {
      const p = record(input, ['rows', 'resultsHash', 'pool']);
      if (state.obligations.some((o) => o.source === 'audience' || o.source === 'judges')) fail('standard_prize_allocated', 409);
      const rows = p.rows as Omit<Obligation, 'status' | 'approvals' | 'note'>[];
      return deepFreeze({ ...addObligations(state, rows, context, `standard prize ${String(p.pool)}`), resultsHash: typeof p.resultsHash === 'string' ? p.resultsHash : null });
    }
    case 'addAwards': {
      const p = record(input, ['awards']);
      const rows = list(p.awards, (raw, i) => { const a = record(raw, ['recipient', 'amount', 'source', 'basis'], 'award');
        return { obligationId: obligationId(context, state.obligations.length + i), recipient: uuid(a.recipient, 'recipient'), amount: amount(a.amount), source: oneOf(a.source, ['placement', 'award'] as const, 'source'), basis: str(a.basis, 'basis', 3, 200) }; }, 'awards', 1, 64);
      return addObligations(state, rows, context, 'placement and special awards');
    }
    case 'approve': {
      const p = record(input, ['obligationId', 'confirm']);
      if (!bool(p.confirm, 'confirm')) fail('confirmation_required', 400);
      const o = state.obligations.find((x) => x.obligationId === p.obligationId) ?? fail('unknown_obligation');
      if (o.status !== 'proposed') fail('not_proposed', 409);
      if (o.recipient === context.actor) fail('self_approval_forbidden', 403);
      if (o.approvals.includes(context.actor)) fail('already_approved', 409);
      const approvals = [...o.approvals, context.actor];
      return deepFreeze({ ...state, obligations: state.obligations.map((x) => x === o ? { ...o, approvals, status: approvals.length >= 2 ? 'approved' as const : 'proposed' as const } : x) });
    }
    case 'hold': case 'release': case 'forfeit': case 'settle': {
      const p = record(input, ['obligationId', 'note']);
      const o = state.obligations.find((x) => x.obligationId === p.obligationId) ?? fail('unknown_obligation');
      const allowed: Record<string, [readonly string[], Obligation['status']]> = { hold: [['proposed', 'approved'], 'held'], release: [['held'], 'approved'], forfeit: [['proposed', 'approved', 'held'], 'forfeited'], settle: [['approved'], 'settled'] };
      const [from, to] = allowed[type] ?? fail('unknown_command', 400);
      if (!from.includes(o.status)) fail('invalid_obligation_state', 409);
      if (type === 'release' && o.approvals.length < 2) fail('needs_two_approvals');
      const note = str(p.note, 'note', 5, 500);
      return deepFreeze({ ...state, obligations: state.obligations.map((x) => x === o ? { ...o, status: to, note } : x),
        journal: type === 'forfeit' ? [...state.journal, { at: context.now, by: context.actor, memo: note, obligationId: o.obligationId, delta: o.amount, direction: 'release' as const }].slice(-400) : state.journal });
    }
    default: return fail('unknown_command', 400);
  }
}
async function latest<T>(db: Queryable, scope: Context['scope'], stream: string, action: string, entity: string): Promise<T> {
  const row = (await db.query<{ result: { records: { snapshot: { data: { state: T } } }[] } }>('SELECT lde_competition.operation_records($1,$2,$3,$4,$5,$6) AS result', [scope?.tenantId, scope?.eventId, stream, action, entity, 2147483647])).rows[0]?.result;
  return row?.records[0]?.snapshot.data.state ?? fail(`unknown_${stream}`);
}
const cmd = (type: string, action: 'prize.manage' | 'payout.approve') => ({ action, apply: (s: PrizeState, p: unknown, c: Context) => applyPrizes(s, type, p, c) });
export const prizesStream = defineStream<PrizeState>({
  name: 'prizes', readAction: 'prize.manage', initial: initialPrizes,
  commands: { fund: cmd('fund', 'prize.manage'), allocateStandard: cmd('allocateStandard', 'prize.manage'), addAwards: cmd('addAwards', 'prize.manage'), approve: cmd('approve', 'payout.approve'),
    hold: cmd('hold', 'prize.manage'), release: cmd('release', 'payout.approve'), forfeit: cmd('forfeit', 'payout.approve'), settle: cmd('settle', 'payout.approve') },
  prepare: async (type, payload, state, context, db) => {
    if (type !== 'allocateStandard') return payload;
    const p = record(payload, ['resultsId', 'rosterId', 'pool']);
    const results = await latest<ResultsState>(db, context.scope, 'results', 'prize.manage', uuid(p.resultsId, 'results'));
    const roster = await latest<RosterState>(db, context.scope, 'roster', 'event.read', uuid(p.rosterId, 'roster'));
    if (roster.status !== 'locked') fail('roster_not_locked');
    const pool = amount(p.pool, 'pool'); if (!lte(pool, state.budget)) fail('exceeds_prize_budget');
    let i = state.obligations.length;
    return { rows: standardPrizeRows(results, roster, pool, () => obligationId(context, i++)), resultsHash: results.resultsHash, pool };
  },
});

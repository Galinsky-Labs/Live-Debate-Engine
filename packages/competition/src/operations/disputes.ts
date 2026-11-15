import { deepFreeze, fail, instant, list, ms, oneOf, record, str, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-30: disputes, sanctions, disqualification and the correction requests they trigger. */
export const DISPUTE_REASONS = ['counting-error', 'scoring-error', 'eligibility', 'conduct', 'technical-error'] as const;
export const REMEDIES = ['none', 'recount', 'rescore', 'sanction', 'disqualification', 'prize-reversal'] as const;
export type Dispute = Readonly<{ disputeId: string; filedBy: string; filedAt: string; subject: 'results' | 'scorecard' | 'prize' | 'conduct'; reason: typeof DISPUTE_REASONS[number]; statement: string; evidence: readonly string[];
  status: 'open' | 'reviewing' | 'upheld' | 'dismissed' | 'withdrawn'; reviewer: string | null; decision: Readonly<{ remedy: typeof REMEDIES[number]; reasoning: string; at: string }> | null }>;
export type Sanction = Readonly<{ sanctionId: string; principalId: string; kind: 'warning' | 'penalty-points' | 'disqualification'; points: number; disputeId: string | null; reason: string; by: string; at: string }>;
export type DisputesState = Readonly<{ windowClosesAt: string | null; disputes: readonly Dispute[]; sanctions: readonly Sanction[]; correctionsRequired: readonly Readonly<{ disputeId: string; remedy: string; at: string }>[] }>;
export function initialDisputes(): DisputesState { return deepFreeze({ windowClosesAt: null, disputes: [], sanctions: [], correctionsRequired: [] }); }

export function applyDisputes(state: DisputesState, type: string, input: unknown, context: Context): DisputesState {
  const find = (id: unknown) => state.disputes.find((d) => d.disputeId === id) ?? fail('unknown_dispute');
  const swap = (d: Dispute, next: Dispute) => deepFreeze({ ...state, disputes: state.disputes.map((x) => x === d ? next : x) });
  switch (type) {
    case 'setWindow': return deepFreeze({ ...state, windowClosesAt: instant(record(input, ['closesAt']).closesAt) });
    case 'file': {
      const p = record(input, ['disputeId', 'subject', 'reason', 'statement', 'evidence']);
      if (!state.windowClosesAt || ms(context.now) > ms(state.windowClosesAt)) fail('dispute_window_closed', 409);
      if (state.disputes.filter((d) => d.filedBy === context.actor && (d.status === 'open' || d.status === 'reviewing')).length >= 3) fail('too_many_open_disputes');
      const dispute: Dispute = { disputeId: uuid(p.disputeId, 'dispute'), filedBy: context.actor, filedAt: context.now, subject: oneOf(p.subject, ['results', 'scorecard', 'prize', 'conduct'] as const, 'subject'),
        reason: oneOf(p.reason, DISPUTE_REASONS, 'reason'), statement: str(p.statement, 'statement', 20, 4000), evidence: list(p.evidence, (e) => uuid(e, 'evidence'), 'evidence', 0, 20), status: 'open', reviewer: null, decision: null };
      if (state.disputes.some((d) => d.disputeId === dispute.disputeId)) fail('duplicate_dispute', 409);
      return deepFreeze({ ...state, disputes: [...state.disputes, dispute].slice(-200) });
    }
    case 'withdraw': {
      const d = find(record(input, ['disputeId']).disputeId);
      if (d.filedBy !== context.actor) fail('not_your_dispute', 403);
      if (d.status !== 'open') fail('not_open', 409);
      return swap(d, { ...d, status: 'withdrawn' });
    }
    case 'assign': {
      const d = find(record(input, ['disputeId']).disputeId);
      if (d.status !== 'open') fail('not_open', 409);
      if (d.filedBy === context.actor) fail('reviewer_conflict', 403);
      return swap(d, { ...d, status: 'reviewing', reviewer: context.actor });
    }
    case 'decide': {
      const p = record(input, ['disputeId', 'upheld', 'remedy', 'reasoning']);
      const d = find(p.disputeId);
      if (d.status !== 'reviewing' || d.reviewer !== context.actor) fail('not_assigned_reviewer', 403);
      const upheld = p.upheld === true; const remedy = oneOf(p.remedy, REMEDIES, 'remedy');
      if (upheld === (remedy === 'none')) fail('remedy_must_match_decision', 400);
      const next = swap(d, { ...d, status: upheld ? 'upheld' : 'dismissed', decision: { remedy, reasoning: str(p.reasoning, 'reasoning', 20, 4000), at: context.now } });
      // Upheld remedies that change outcomes require reopening certified results (E-26) and ledger review (E-27).
      return ['recount', 'rescore', 'disqualification', 'prize-reversal'].includes(remedy) ? deepFreeze({ ...next, correctionsRequired: [...next.correctionsRequired, { disputeId: d.disputeId, remedy, at: context.now }] }) : next;
    }
    case 'sanction': {
      const p = record(input, ['sanctionId', 'principalId', 'kind', 'points', 'disputeId', 'reason']);
      const kind = oneOf(p.kind, ['warning', 'penalty-points', 'disqualification'] as const, 'kind');
      const points = typeof p.points === 'number' && Number.isSafeInteger(p.points) && p.points >= 0 && p.points <= 10 ? p.points : fail('invalid_points', 400);
      if ((kind === 'penalty-points') !== (points > 0)) fail('points_only_for_penalties', 400);
      const disputeId = p.disputeId === null ? null : find(p.disputeId).disputeId;
      const sanction: Sanction = { sanctionId: uuid(p.sanctionId, 'sanction'), principalId: uuid(p.principalId, 'principal'), kind, points, disputeId, reason: str(p.reason, 'reason', 10, 1000), by: context.actor, at: context.now };
      if (sanction.principalId === context.actor) fail('self_sanction_forbidden', 403);
      return deepFreeze({ ...state, sanctions: [...state.sanctions, sanction].slice(-200),
        correctionsRequired: kind === 'disqualification' ? [...state.correctionsRequired, { disputeId: disputeId ?? sanction.sanctionId, remedy: 'disqualification', at: context.now }] : state.correctionsRequired });
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'dispute.review' | 'participant.self' | 'event.manage') => ({ action, apply: (s: DisputesState, p: unknown, c: Context) => applyDisputes(s, type, p, c) });
export const disputesStream = defineStream<DisputesState>({
  name: 'disputes', readAction: 'dispute.review', initial: initialDisputes,
  commands: { setWindow: cmd('setWindow', 'event.manage'), file: cmd('file', 'participant.self'), withdraw: cmd('withdraw', 'participant.self'),
    assign: cmd('assign', 'dispute.review'), decide: cmd('decide', 'dispute.review'), sanction: cmd('sanction', 'dispute.review') },
  view: (state, actor) => ({ windowClosesAt: state.windowClosesAt, mine: state.disputes.filter((d) => d.filedBy === actor), sanctions: state.sanctions.filter((s) => s.principalId === actor) }),
});

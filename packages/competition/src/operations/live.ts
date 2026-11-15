import { PHASES } from '../../../contracts/src/domain.js';
import { bool, deepFreeze, fail, oneOf, record, str, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-13: authoritative event state machine with guarded, attributed transitions. */
export type Phase = typeof PHASES[number];
export const READINESS = ['roster-locked', 'eligibility-complete', 'admission-allocated', 'media-ready', 'polls-configured'] as const;
export type Transition = Readonly<{ seq: number; from: Phase; to: Phase; at: string; by: string; reason: string | null }>;
export type LiveState = Readonly<{ phase: Phase; sequence: number; suspended: boolean; readiness: readonly string[]; history: readonly Transition[] }>;

const NEXT: Readonly<Partial<Record<Phase, Phase>>> = {
  preparation: 'readiness', readiness: 'pre-vote', 'pre-vote': 'openings', openings: 'discussion', discussion: 'questions',
  questions: 'closings', closings: 'post-vote', 'post-vote': 'verification', verification: 'announcement', announcement: 'closed',
};
export const SPEAKING_PHASES: readonly Phase[] = ['openings', 'discussion', 'questions', 'closings'];
export function initialLive(): LiveState { return deepFreeze({ phase: 'preparation', sequence: 0, suspended: false, readiness: [], history: [] }); }
export function nextPhase(phase: Phase): Phase | null { return NEXT[phase] ?? null; }

function move(state: LiveState, to: Phase, context: Context, reason: string | null): LiveState {
  const entry: Transition = { seq: state.sequence + 1, from: state.phase, to, at: context.now, by: context.actor, reason };
  return deepFreeze({ ...state, phase: to, sequence: entry.seq, history: [...state.history, entry].slice(-100) });
}
function advanceTo(state: LiveState, input: unknown, context: Context, allowed: readonly Phase[]): LiveState {
  const p = record(input, ['from', 'to']);
  const from = oneOf(p.from, PHASES, 'phase'); const to = oneOf(p.to, PHASES, 'phase');
  // The caller states the phase it observed; a stale console cannot skip a phase.
  if (from !== state.phase) fail('phase_conflict', 409);
  if (state.suspended) fail('event_suspended', 409);
  if (nextPhase(from) !== to || !allowed.includes(to)) fail('transition_not_allowed', 409);
  if (to === 'pre-vote' && READINESS.some((r) => !state.readiness.includes(r))) fail('not_ready');
  return move(state, to, context, null);
}
export function applyLive(state: LiveState, type: string, input: unknown, context: Context): LiveState {
  switch (type) {
    case 'confirmReadiness': {
      const p = record(input, ['item', 'confirmed']);
      const item = oneOf(p.item, READINESS, 'readiness');
      if (!['preparation', 'readiness'].includes(state.phase)) fail('readiness_closed', 409);
      const set = new Set(state.readiness); if (bool(p.confirmed, 'confirmed')) set.add(item); else set.delete(item);
      return deepFreeze({ ...state, readiness: [...set].sort() });
    }
    case 'advance': return advanceTo(state, input, context, ['readiness', 'pre-vote', 'openings', 'discussion', 'questions', 'closings', 'post-vote', 'verification']);
    case 'announce': return advanceTo(state, input, context, ['announcement']);
    case 'close': return advanceTo(state, input, context, ['closed']);
    case 'suspend': case 'resume': {
      const reason = str(record(input, ['reason']).reason, 'reason', 5, 500);
      if (['closed', 'cancelled'].includes(state.phase)) fail('event_finished', 409);
      if ((type === 'suspend') === state.suspended) fail(type === 'suspend' ? 'already_suspended' : 'not_suspended', 409);
      const entry: Transition = { seq: state.sequence + 1, from: state.phase, to: state.phase, at: context.now, by: context.actor, reason: `${type}: ${reason}` };
      return deepFreeze({ ...state, suspended: type === 'suspend', sequence: entry.seq, history: [...state.history, entry].slice(-100) });
    }
    case 'cancel': {
      const reason = str(record(input, ['reason']).reason, 'reason', 10, 1000);
      if (['closed', 'cancelled', 'announcement'].includes(state.phase)) fail('cannot_cancel', 409);
      return move({ ...state, suspended: false }, 'cancelled', context, reason);
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'session.control' | 'result.publish' | 'event.manage') => ({ action, apply: (s: LiveState, p: unknown, c: Context) => applyLive(s, type, p, c) });
export const liveStream = defineStream<LiveState>({
  name: 'live', readAction: 'event.read', initial: initialLive,
  commands: { confirmReadiness: cmd('confirmReadiness', 'event.manage'), advance: cmd('advance', 'session.control'), suspend: cmd('suspend', 'session.control'),
    resume: cmd('resume', 'session.control'), announce: cmd('announce', 'result.publish'), close: cmd('close', 'result.publish'), cancel: cmd('cancel', 'event.manage') },
});

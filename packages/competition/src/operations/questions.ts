import { deepFreeze, fail, ms, oneOf, record, str, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-19: audience Q&A with moderation, rate limits and conduct controls. */
export type Question = Readonly<{ questionId: string; author: string; text: string; at: string; status: 'pending' | 'approved' | 'rejected' | 'answered' | 'merged'; mergedInto: string | null; directedTo: 'for' | 'against' | 'both' }>;
export type Conduct = Readonly<{ principalId: string; strikes: number; status: 'ok' | 'muted' | 'ejected'; notes: readonly Readonly<{ at: string; by: string; note: string }>[] }>;
export type QuestionsState = Readonly<{ open: boolean; questions: readonly Question[]; conduct: readonly Conduct[] }>;
export const LIMITS = Object.freeze({ pendingPerAuthor: 2, minIntervalMs: 60000, strikesToMute: 2, strikesToEject: 3 });
export function initialQuestions(): QuestionsState { return deepFreeze({ open: false, questions: [], conduct: [] }); }

function conductOf(state: QuestionsState, principalId: string): Conduct { return state.conduct.find((c) => c.principalId === principalId) ?? { principalId, strikes: 0, status: 'ok', notes: [] }; }
function setConduct(state: QuestionsState, next: Conduct): QuestionsState {
  return deepFreeze({ ...state, conduct: [...state.conduct.filter((c) => c.principalId !== next.principalId), next].slice(-500) });
}
function moderate(state: QuestionsState, id: unknown, status: Question['status'], mergedInto: string | null = null): QuestionsState {
  const question = state.questions.find((q) => q.questionId === id) ?? fail('unknown_question');
  const allowed: Record<string, readonly string[]> = { approved: ['pending'], rejected: ['pending', 'approved'], answered: ['approved'], merged: ['pending', 'approved'] };
  if (!allowed[status]?.includes(question.status)) fail('invalid_question_state', 409);
  return deepFreeze({ ...state, questions: state.questions.map((q) => q === question ? { ...q, status, mergedInto } : q) });
}
export function applyQuestions(state: QuestionsState, type: string, input: unknown, context: Context): QuestionsState {
  switch (type) {
    case 'setOpen': { const p = record(input, ['open']); return deepFreeze({ ...state, open: p.open === true }); }
    case 'submit': {
      const p = record(input, ['questionId', 'text', 'directedTo']);
      if (!state.open) fail('questions_closed', 409);
      const conduct = conductOf(state, context.actor);
      if (conduct.status !== 'ok') fail('participation_restricted', 403);
      const mine = state.questions.filter((q) => q.author === context.actor);
      if (mine.filter((q) => q.status === 'pending').length >= LIMITS.pendingPerAuthor) fail('too_many_pending');
      const last = mine[mine.length - 1];
      if (last && ms(context.now) - ms(last.at) < LIMITS.minIntervalMs) fail('rate_limited');
      if (state.questions.length >= 400) fail('question_queue_full');
      const question: Question = { questionId: uuid(p.questionId, 'question'), author: context.actor, text: str(p.text, 'text', 5, 600), at: context.now, status: 'pending', mergedInto: null, directedTo: oneOf(p.directedTo, ['for', 'against', 'both'] as const, 'side') };
      if (state.questions.some((q) => q.questionId === question.questionId)) fail('duplicate_question', 409);
      return deepFreeze({ ...state, questions: [...state.questions, question] });
    }
    case 'approve': return moderate(state, record(input, ['questionId']).questionId, 'approved');
    case 'reject': return moderate(state, record(input, ['questionId']).questionId, 'rejected');
    case 'markAnswered': return moderate(state, record(input, ['questionId']).questionId, 'answered');
    case 'merge': {
      const p = record(input, ['questionId', 'into']);
      const target = state.questions.find((q) => q.questionId === p.into && q.status === 'approved') ?? fail('invalid_merge_target');
      if (target.questionId === p.questionId) fail('invalid_merge_target');
      return moderate(state, p.questionId, 'merged', target.questionId);
    }
    case 'strike': {
      const p = record(input, ['principalId', 'note']);
      const current = conductOf(state, uuid(p.principalId, 'principal'));
      if (current.status === 'ejected') fail('already_ejected', 409);
      const strikes = current.strikes + 1;
      const status = strikes >= LIMITS.strikesToEject ? 'ejected' : strikes >= LIMITS.strikesToMute ? 'muted' : 'ok';
      const next = setConduct(state, { ...current, strikes, status, notes: [...current.notes, { at: context.now, by: context.actor, note: str(p.note, 'note', 5, 300) }] });
      return status === 'ok' ? next : deepFreeze({ ...next, questions: next.questions.map((q) => q.author === current.principalId && q.status === 'pending' ? { ...q, status: 'rejected' as const } : q) });
    }
    case 'restore': {
      const p = record(input, ['principalId', 'note']);
      const current = conductOf(state, uuid(p.principalId, 'principal'));
      return setConduct(state, { ...current, strikes: 0, status: 'ok', notes: [...current.notes, { at: context.now, by: context.actor, note: str(p.note, 'note', 5, 300) }] });
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'question.submit' | 'question.moderate') => ({ action, apply: (s: QuestionsState, p: unknown, c: Context) => applyQuestions(s, type, p, c) });
export const questionsStream = defineStream<QuestionsState>({
  name: 'questions', readAction: 'question.moderate', initial: initialQuestions,
  commands: { setOpen: cmd('setOpen', 'question.moderate'), submit: cmd('submit', 'question.submit'), approve: cmd('approve', 'question.moderate'), reject: cmd('reject', 'question.moderate'),
    markAnswered: cmd('markAnswered', 'question.moderate'), merge: cmd('merge', 'question.moderate'), strike: cmd('strike', 'question.moderate'), restore: cmd('restore', 'question.moderate') },
  // Audience members see approved/answered questions (without authors) plus their own submissions and standing.
  view: (state, actor) => ({ open: state.open,
    queue: state.questions.filter((q) => q.status === 'approved' || q.status === 'answered').map(({ author: _author, ...rest }) => rest),
    mine: state.questions.filter((q) => q.author === actor), conduct: state.conduct.find((c) => c.principalId === actor)?.status ?? 'ok' }),
});

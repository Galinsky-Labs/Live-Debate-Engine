import { createHash } from 'node:crypto';
import { bool, deepFreeze, fail, instant, int, list, ms, oneOf, record, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-17: recording and broadcast production with consent gating and a hash-chained segment manifest. */
export type Segment = Readonly<{ segmentId: string; startedAt: string; endedAt: string; sha256: string; bytes: number; chain: string }>;
export type RecordingState = Readonly<{
  status: 'idle' | 'recording' | 'paused' | 'finalized'; requiredConsents: readonly string[]; consents: readonly string[];
  segments: readonly Segment[]; broadcast: Readonly<{ status: 'offline' | 'live' | 'ended'; delaySeconds: number }>; manifestHash: string | null;
}>;
export const GENESIS = '0'.repeat(64);
export function initialRecording(): RecordingState {
  return deepFreeze({ status: 'idle', requiredConsents: [], consents: [], segments: [], broadcast: { status: 'offline', delaySeconds: 0 }, manifestHash: null });
}
export function chainHash(previous: string, segment: Omit<Segment, 'chain'>): string {
  return createHash('sha256').update(`${previous}|${segment.segmentId}|${segment.startedAt}|${segment.endedAt}|${segment.sha256}|${segment.bytes}`).digest('hex');
}
/** Recompute the chain; any edited, removed or reordered segment breaks verification. */
export function verifyManifest(state: RecordingState): boolean {
  let previous = GENESIS;
  for (const segment of state.segments) { if (chainHash(previous, segment) !== segment.chain) return false; previous = segment.chain; }
  return state.manifestHash === null || state.manifestHash === previous;
}
const missingConsent = (state: RecordingState) => state.requiredConsents.filter((p) => !state.consents.includes(p));
const sha = (v: unknown) => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('invalid_sha256', 400); return v; };

export function applyRecording(state: RecordingState, type: string, input: unknown, context: Context): RecordingState {
  switch (type) {
    case 'requireConsents': {
      if (state.status !== 'idle') fail('recording_started', 409);
      const people = list(record(input, ['principalIds']).principalIds, (p) => uuid(p, 'principal'), 'principals', 0, 60);
      return deepFreeze({ ...state, requiredConsents: [...new Set(people)].sort(), consents: state.consents.filter((c) => people.includes(c)) });
    }
    case 'consent': {
      const given = bool(record(input, ['given']).given, 'given');
      if (!state.requiredConsents.includes(context.actor)) fail('consent_not_requested', 403);
      if (!given && state.status !== 'idle') fail('withdraw_requires_producer_review', 409);
      const set = new Set(state.consents); if (given) set.add(context.actor); else set.delete(context.actor);
      return deepFreeze({ ...state, consents: [...set].sort() });
    }
    case 'start': case 'resume': {
      record(input, []);
      if (type === 'start' ? state.status !== 'idle' : state.status !== 'paused') fail('invalid_recording_state', 409);
      if (missingConsent(state).length) fail('consent_missing');
      return deepFreeze({ ...state, status: 'recording' });
    }
    case 'pause': record(input, []); if (state.status !== 'recording') fail('not_recording', 409); return deepFreeze({ ...state, status: 'paused' });
    case 'addSegment': {
      const p = record(input, ['segmentId', 'startedAt', 'endedAt', 'sha256', 'bytes']);
      if (!['recording', 'paused'].includes(state.status)) fail('not_recording', 409);
      const base = { segmentId: uuid(p.segmentId, 'segment'), startedAt: instant(p.startedAt), endedAt: instant(p.endedAt), sha256: sha(p.sha256), bytes: int(p.bytes, 'bytes', 1, 2147483647) };
      if (ms(base.endedAt) <= ms(base.startedAt)) fail('invalid_interval', 400);
      const last = state.segments[state.segments.length - 1];
      if (last && ms(base.startedAt) < ms(last.endedAt)) fail('overlapping_segment');
      if (state.segments.some((s) => s.segmentId === base.segmentId)) fail('duplicate_segment', 409);
      if (state.segments.length >= 400) fail('too_many_segments');
      return deepFreeze({ ...state, segments: [...state.segments, { ...base, chain: chainHash(last?.chain ?? GENESIS, base) }] });
    }
    case 'finalize': {
      record(input, []);
      if (!['recording', 'paused'].includes(state.status) || state.segments.length === 0) fail('nothing_to_finalize', 409);
      return deepFreeze({ ...state, status: 'finalized', manifestHash: state.segments[state.segments.length - 1]?.chain ?? null });
    }
    case 'broadcast': {
      const p = record(input, ['status', 'delaySeconds']);
      const status = oneOf(p.status, ['offline', 'live', 'ended'] as const, 'status');
      if (state.broadcast.status === 'ended') fail('broadcast_ended', 409);
      if (status === 'live' && missingConsent(state).length) fail('consent_missing');
      return deepFreeze({ ...state, broadcast: { status, delaySeconds: int(p.delaySeconds, 'delay', 0, 600) } });
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'media.control' | 'participant.self') => ({ action, apply: (s: RecordingState, p: unknown, c: Context) => applyRecording(s, type, p, c) });
export const recordingStream = defineStream<RecordingState>({
  name: 'recording', readAction: 'event.read', initial: initialRecording,
  commands: { requireConsents: cmd('requireConsents', 'media.control'), consent: cmd('consent', 'participant.self'), start: cmd('start', 'media.control'), pause: cmd('pause', 'media.control'),
    resume: cmd('resume', 'media.control'), addSegment: cmd('addSegment', 'media.control'), finalize: cmd('finalize', 'media.control'), broadcast: cmd('broadcast', 'media.control') },
});

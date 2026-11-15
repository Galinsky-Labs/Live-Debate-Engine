import { deepFreeze, fail, instant, int, list, ms, oneOf, record, str, uuid, type Context } from './common.js';
import type { SpeechLog } from './floor.js';
import { defineStream } from './stream.js';

/** E-18: transcription segments, speaker attribution from the floor log, and audited corrections. */
export type TranscriptSegment = Readonly<{ segmentId: string; offsetMs: number; durationMs: number; speakerId: string | null; attribution: 'floor-log' | 'manual' | 'unknown'; text: string; source: 'asr' | 'human'; revision: number }>;
export type Correction = Readonly<{ segmentId: string; revision: number; previousText: string; text: string; reason: string; by: string; at: string }>;
export type TranscriptState = Readonly<{ startedAt: string | null; status: 'open' | 'published'; segments: readonly TranscriptSegment[]; corrections: readonly Correction[] }>;
export function initialTranscript(): TranscriptState { return deepFreeze({ startedAt: null, status: 'open', segments: [], corrections: [] }); }

/** The speaker is whoever held the floor for the majority of the segment, per the authoritative log. */
export function attributeSpeaker(startedAt: string, offsetMs: number, durationMs: number, log: readonly SpeechLog[]): string | null {
  const from = ms(startedAt) + offsetMs; const to = from + durationMs;
  let best: { id: string; overlap: number } | null = null;
  for (const entry of log) {
    const s = ms(entry.startedAt); const e = entry.endedAt ? ms(entry.endedAt) : Number.MAX_SAFE_INTEGER;
    const overlap = Math.min(to, e) - Math.max(from, s);
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { id: entry.speakerId, overlap };
  }
  return best && best.overlap * 2 > durationMs ? best.id : null;
}
export function renderTranscript(state: TranscriptState): string {
  return [...state.segments].sort((a, b) => a.offsetMs - b.offsetMs).map((s) => `[${Math.floor(s.offsetMs / 1000)}s] ${s.speakerId ?? 'Unattributed'}: ${s.text}`).join('\n');
}

export function applyTranscript(state: TranscriptState, type: string, input: unknown, context: Context): TranscriptState {
  switch (type) {
    case 'begin': { const p = record(input, ['startedAt']); if (state.startedAt) fail('already_started', 409); return deepFreeze({ ...state, startedAt: instant(p.startedAt) }); }
    case 'appendSegment': {
      const p = record(input, ['segmentId', 'offsetMs', 'durationMs', 'text', 'source', 'speakerLog']);
      if (!state.startedAt) fail('not_started', 409);
      if (state.status !== 'open') fail('transcript_published', 409);
      const offsetMs = int(p.offsetMs, 'offset', 0, 86400000); const durationMs = int(p.durationMs, 'duration', 1, 600000);
      // Caller supplies the authoritative floor log entries (read from the floor stream by the server/console).
      const log: SpeechLog[] = list(p.speakerLog, (raw) => { const e = record(raw, ['segment', 'speakerId', 'startedAt', 'endedAt', 'elapsedMs'], 'speaker_log');
        return { segment: str(e.segment, 'segment', 1, 40), speakerId: uuid(e.speakerId, 'speaker'), startedAt: instant(e.startedAt), endedAt: e.endedAt === null ? null : instant(e.endedAt), elapsedMs: int(e.elapsedMs, 'elapsed') }; }, 'speaker_log', 0, 60);
      const speakerId = attributeSpeaker(state.startedAt, offsetMs, durationMs, log);
      const segment: TranscriptSegment = { segmentId: uuid(p.segmentId, 'segment'), offsetMs, durationMs, speakerId, attribution: speakerId ? 'floor-log' : 'unknown', text: str(p.text, 'text', 1, 4000), source: oneOf(p.source, ['asr', 'human'] as const, 'source'), revision: 1 };
      if (state.segments.some((s) => s.segmentId === segment.segmentId)) fail('duplicate_segment', 409);
      if (state.segments.length >= 500) fail('transcript_full');
      return deepFreeze({ ...state, segments: [...state.segments, segment] });
    }
    case 'correct': {
      const p = record(input, ['segmentId', 'text', 'speakerId', 'reason']);
      const segment = state.segments.find((s) => s.segmentId === p.segmentId) ?? fail('unknown_segment');
      const text = str(p.text, 'text', 1, 4000); const speakerId = p.speakerId === null ? segment.speakerId : uuid(p.speakerId, 'speaker');
      if (text === segment.text && speakerId === segment.speakerId) fail('no_change');
      const correction: Correction = { segmentId: segment.segmentId, revision: segment.revision + 1, previousText: segment.text, text, reason: str(p.reason, 'reason', 5, 500), by: context.actor, at: context.now };
      const next: TranscriptSegment = { ...segment, text, speakerId, attribution: speakerId === segment.speakerId ? segment.attribution : 'manual', revision: correction.revision };
      return deepFreeze({ ...state, segments: state.segments.map((s) => s === segment ? next : s), corrections: [...state.corrections, correction].slice(-300) });
    }
    case 'publish': record(input, []); if (state.status === 'published') fail('already_published', 409); return deepFreeze({ ...state, status: 'published' });
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string) => ({ action: 'event.manage' as const, apply: (s: TranscriptState, p: unknown, c: Context) => applyTranscript(s, type, p, c) });
export const transcriptStream = defineStream<TranscriptState>({
  name: 'transcript', readAction: 'event.read', initial: initialTranscript,
  commands: Object.fromEntries(['begin', 'appendSegment', 'correct', 'publish'].map((t) => [t, cmd(t)])),
});

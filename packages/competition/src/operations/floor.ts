import { bool, deepFreeze, fail, int, ms, oneOf, record, str, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-14: server-authoritative speech timers, floor control and points of information/order. */
export type Timer = Readonly<{ status: 'idle' | 'running' | 'paused' | 'stopped'; allottedMs: number; elapsedMs: number; runningSince: string | null; graceMs: number; protectedMs: number }>;
export type Point = Readonly<{ pointId: string; kind: 'information' | 'order'; raisedBy: string; at: string; status: 'pending' | 'accepted' | 'declined' | 'upheld' | 'overruled' | 'withdrawn'; note: string | null }>;
export type SpeechLog = Readonly<{ segment: string; speakerId: string; startedAt: string; endedAt: string | null; elapsedMs: number }>;
export type FloorState = Readonly<{ speakerId: string | null; segment: string | null; timer: Timer; requests: readonly Readonly<{ principalId: string; at: string }>[]; points: readonly Point[]; log: readonly SpeechLog[]; adjustments: readonly Readonly<{ at: string; by: string; deltaMs: number; reason: string }>[] }>;

const idle: Timer = { status: 'idle', allottedMs: 0, elapsedMs: 0, runningSince: null, graceMs: 0, protectedMs: 0 };
export function initialFloor(): FloorState { return deepFreeze({ speakerId: null, segment: null, timer: idle, requests: [], points: [], log: [], adjustments: [] }); }

export function elapsed(timer: Timer, now: string): number {
  return timer.elapsedMs + (timer.status === 'running' && timer.runningSince ? Math.max(0, ms(now) - ms(timer.runningSince)) : 0);
}
/** Remaining time and signal for consoles: normal, warning (last 30s), grace, overtime. */
export function timerReading(timer: Timer, now: string): Readonly<{ remainingMs: number; signal: 'idle' | 'normal' | 'warning' | 'grace' | 'overtime'; protected: boolean }> {
  if (timer.status === 'idle') return { remainingMs: 0, signal: 'idle', protected: false };
  const used = elapsed(timer, now); const remaining = timer.allottedMs - used;
  const signal = remaining > 30000 ? 'normal' : remaining > 0 ? 'warning' : -remaining <= timer.graceMs ? 'grace' : 'overtime';
  const inProtected = used < timer.protectedMs || remaining < timer.protectedMs;
  return { remainingMs: remaining, signal, protected: inProtected };
}
function freezeTimer(timer: Timer, now: string, status: Timer['status']): Timer {
  return { ...timer, elapsedMs: elapsed(timer, now), runningSince: status === 'running' ? now : null, status };
}
function closeLog(state: FloorState, now: string): readonly SpeechLog[] {
  const last = state.log[state.log.length - 1];
  if (!last || last.endedAt !== null) return state.log;
  return [...state.log.slice(0, -1), { ...last, endedAt: now, elapsedMs: elapsed(state.timer, now) }];
}

export function applyFloor(state: FloorState, type: string, input: unknown, context: Context): FloorState {
  const now = context.now;
  switch (type) {
    case 'startSpeech': {
      const p = record(input, ['speakerId', 'segment', 'seconds', 'graceSeconds', 'protectedSeconds']);
      if (state.timer.status === 'running' || state.timer.status === 'paused') fail('speech_in_progress', 409);
      const speakerId = uuid(p.speakerId, 'speaker'); const segment = str(p.segment, 'segment', 1, 40);
      const timer: Timer = { status: 'running', allottedMs: int(p.seconds, 'seconds', 1, 7200) * 1000, elapsedMs: 0, runningSince: now, graceMs: int(p.graceSeconds, 'grace', 0, 300) * 1000, protectedMs: int(p.protectedSeconds, 'protected', 0, 300) * 1000 };
      return deepFreeze({ ...state, speakerId, segment, timer, requests: state.requests.filter((r) => r.principalId !== speakerId),
        points: state.points.map((pt) => pt.status === 'pending' ? { ...pt, status: 'withdrawn' as const } : pt), log: [...state.log, { segment, speakerId, startedAt: now, endedAt: null, elapsedMs: 0 }].slice(-60) });
    }
    case 'pause': record(input, []); if (state.timer.status !== 'running') fail('timer_not_running', 409); return deepFreeze({ ...state, timer: freezeTimer(state.timer, now, 'paused') });
    case 'resume': record(input, []); if (state.timer.status !== 'paused') fail('timer_not_paused', 409); return deepFreeze({ ...state, timer: { ...state.timer, status: 'running', runningSince: now } });
    case 'stop': {
      record(input, []);
      if (!['running', 'paused'].includes(state.timer.status)) fail('timer_not_active', 409);
      return deepFreeze({ ...state, log: closeLog(state, now), timer: freezeTimer(state.timer, now, 'stopped'), speakerId: null, points: state.points.map((pt) => pt.status === 'pending' ? { ...pt, status: 'withdrawn' as const } : pt) });
    }
    case 'adjust': {
      const p = record(input, ['deltaSeconds', 'reason']);
      const deltaMs = int(p.deltaSeconds, 'delta', -600, 600) * 1000;
      if (deltaMs === 0 || !['running', 'paused'].includes(state.timer.status)) fail('nothing_to_adjust', 409);
      const allottedMs = state.timer.allottedMs + deltaMs; if (allottedMs < 1000) fail('invalid_adjustment');
      return deepFreeze({ ...state, timer: { ...state.timer, allottedMs }, adjustments: [...state.adjustments, { at: now, by: context.actor, deltaMs, reason: str(p.reason, 'reason', 5, 300) }].slice(-50) });
    }
    case 'requestFloor': {
      record(input, []);
      if (state.requests.some((r) => r.principalId === context.actor) || state.speakerId === context.actor) fail('already_requested', 409);
      return deepFreeze({ ...state, requests: [...state.requests, { principalId: context.actor, at: now }].slice(-30) });
    }
    case 'withdrawRequest': record(input, []); return deepFreeze({ ...state, requests: state.requests.filter((r) => r.principalId !== context.actor) });
    case 'raisePoint': {
      const p = record(input, ['pointId', 'kind']);
      const kind = oneOf(p.kind, ['information', 'order'] as const, 'kind');
      if (state.timer.status !== 'running' || state.speakerId === null) fail('no_active_speech', 409);
      if (state.speakerId === context.actor) fail('speaker_cannot_raise_point', 403);
      if (kind === 'information' && timerReading(state.timer, now).protected) fail('protected_time');
      if (state.points.some((pt) => pt.raisedBy === context.actor && pt.status === 'pending')) fail('point_pending', 409);
      return deepFreeze({ ...state, points: [...state.points, { pointId: uuid(p.pointId, 'point'), kind, raisedBy: context.actor, at: now, status: 'pending' as const, note: null }].slice(-100) });
    }
    case 'respondPoint': {
      const p = record(input, ['pointId', 'accept']);
      const point = state.points.find((pt) => pt.pointId === p.pointId && pt.status === 'pending' && pt.kind === 'information') ?? fail('unknown_point');
      if (state.speakerId !== context.actor) fail('only_speaker_responds', 403);
      return deepFreeze({ ...state, points: state.points.map((pt) => pt === point ? { ...pt, status: bool(p.accept, 'accept') ? 'accepted' as const : 'declined' as const } : pt) });
    }
    case 'rulePoint': {
      const p = record(input, ['pointId', 'ruling', 'note']);
      const point = state.points.find((pt) => pt.pointId === p.pointId && pt.status === 'pending' && pt.kind === 'order') ?? fail('unknown_point');
      return deepFreeze({ ...state, points: state.points.map((pt) => pt === point ? { ...pt, status: oneOf(p.ruling, ['upheld', 'overruled'] as const, 'ruling'), note: str(p.note, 'note', 1, 500) } : pt) });
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'timer.control' | 'floor.participate' | 'session.control') => ({ action, apply: (s: FloorState, p: unknown, c: Context) => applyFloor(s, type, p, c) });
export const floorStream = defineStream<FloorState>({
  name: 'floor', readAction: 'event.read', initial: initialFloor,
  commands: { startSpeech: cmd('startSpeech', 'timer.control'), pause: cmd('pause', 'timer.control'), resume: cmd('resume', 'timer.control'), stop: cmd('stop', 'timer.control'),
    adjust: cmd('adjust', 'timer.control'), requestFloor: cmd('requestFloor', 'floor.participate'), withdrawRequest: cmd('withdrawRequest', 'floor.participate'),
    raisePoint: cmd('raisePoint', 'floor.participate'), respondPoint: cmd('respondPoint', 'floor.participate'), rulePoint: cmd('rulePoint', 'session.control') },
});

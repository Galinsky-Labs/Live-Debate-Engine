/** Browser-safe console model (E-15): mirrors the server reducers' ordering and timer arithmetic. */
export const PHASE_ORDER = ['preparation', 'readiness', 'pre-vote', 'openings', 'discussion', 'questions', 'closings', 'post-vote', 'verification', 'announcement', 'closed'] as const;
export const READINESS_ITEMS = ['roster-locked', 'eligibility-complete', 'admission-allocated', 'media-ready', 'polls-configured'] as const;
export type ConsoleRole = 'moderator' | 'timekeeper' | 'debater' | 'producer';
export type LiveView = Readonly<{ phase: string; suspended: boolean; readiness: readonly string[]; sequence: number }>;
export type TimerView = Readonly<{ status: 'idle' | 'running' | 'paused' | 'stopped'; allottedMs: number; elapsedMs: number; runningSince: string | null; graceMs: number; protectedMs: number }>;
export type FloorView = Readonly<{ speakerId: string | null; segment: string | null; timer: TimerView; requests: readonly { principalId: string }[]; points: readonly { pointId: string; kind: string; raisedBy: string; status: string }[] }>;
export function nextPhase(phase: string): string | null { const i = PHASE_ORDER.indexOf(phase as typeof PHASE_ORDER[number]); return i >= 0 && i < PHASE_ORDER.length - 1 ? PHASE_ORDER[i + 1] ?? null : null; }
/** Which command advances from `phase` (announce/close are publication commands). */
export function advanceCommand(phase: string): 'advance' | 'announce' | 'close' | null {
  const next = nextPhase(phase); return next === null ? null : next === 'announcement' ? 'announce' : next === 'closed' ? 'close' : 'advance';
}
export function remainingSeconds(timer: TimerView, nowMs: number): number {
  const elapsed = timer.elapsedMs + (timer.status === 'running' && timer.runningSince ? Math.max(0, nowMs - Date.parse(timer.runningSince)) : 0);
  return Math.max(0, Math.ceil((timer.allottedMs - elapsed) / 1000));
}
export function overtime(timer: TimerView, nowMs: number): 'none' | 'grace' | 'overtime' {
  if (timer.status === 'idle') return 'none';
  const elapsed = timer.elapsedMs + (timer.status === 'running' && timer.runningSince ? Math.max(0, nowMs - Date.parse(timer.runningSince)) : 0);
  const over = elapsed - timer.allottedMs; return over <= 0 ? 'none' : over <= timer.graceMs ? 'grace' : 'overtime';
}
export function roleActions(role: ConsoleRole, live: LiveView, floor: FloorView, viewer: string): readonly string[] {
  if (role === 'moderator') return [...(advanceCommand(live.phase) === 'advance' && !live.suspended ? ['advance'] : []), live.suspended ? 'resume' : 'suspend', ...(floor.points.some((p) => p.kind === 'order' && p.status === 'pending') ? ['rulePoint'] : [])];
  if (role === 'timekeeper') return floor.timer.status === 'running' ? ['pause', 'stop', 'adjust'] : floor.timer.status === 'paused' ? ['resume', 'stop', 'adjust'] : ['startSpeech'];
  if (role === 'producer') return [...(['preparation', 'readiness'].includes(live.phase) ? ['confirmReadiness'] : []), ...(live.phase === 'verification' ? ['announce'] : live.phase === 'announcement' ? ['close'] : [])];
  if (floor.speakerId === viewer) return floor.points.some((p) => p.kind === 'information' && p.status === 'pending') ? ['respondPoint'] : [];
  return floor.timer.status === 'running' ? ['raisePoint', 'requestFloor'] : ['requestFloor'];
}

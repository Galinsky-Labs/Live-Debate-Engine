import type { FloorState } from './floor.js';
import { timerReading } from './floor.js';
import { nextPhase, type LiveState } from './live.js';

/** E-15: role-specific console view models derived from authoritative live and floor state. */
export type ConsoleRole = 'moderator' | 'timekeeper' | 'producer' | 'debater';
export function consoleView(role: ConsoleRole, live: LiveState, floor: FloorState, now: string, viewer: string) {
  const reading = timerReading(floor.timer, now);
  const common = { phase: live.phase, suspended: live.suspended, sequence: live.sequence, speakerId: floor.speakerId, segment: floor.segment, timer: { status: floor.timer.status, ...reading } };
  switch (role) {
    case 'moderator': return Object.freeze({ ...common, nextPhase: live.suspended ? null : nextPhase(live.phase), floorRequests: floor.requests,
      pendingPointsOfOrder: floor.points.filter((p) => p.kind === 'order' && p.status === 'pending'), actions: ['advance', 'suspend', 'resume', 'rulePoint'] });
    case 'timekeeper': return Object.freeze({ ...common, adjustments: floor.adjustments.slice(-5), actions: floor.timer.status === 'running' ? ['pause', 'stop', 'adjust'] : floor.timer.status === 'paused' ? ['resume', 'stop', 'adjust'] : ['startSpeech'] });
    case 'producer': return Object.freeze({ ...common, readiness: live.readiness, history: live.history.slice(-10), actions: ['confirmReadiness', 'announce', 'close'] });
    case 'debater': {
      const speaking = floor.speakerId === viewer;
      const pendingOwn = floor.points.find((p) => p.raisedBy === viewer && p.status === 'pending') ?? null;
      const incoming = speaking ? floor.points.filter((p) => p.kind === 'information' && p.status === 'pending') : [];
      return Object.freeze({ ...common, speaking, pendingOwnPoint: pendingOwn, incomingPoints: incoming, requested: floor.requests.some((r) => r.principalId === viewer),
        actions: speaking ? ['respondPoint'] : floor.timer.status === 'running' ? ['raisePoint', 'requestFloor'] : ['requestFloor'] });
    }
  }
}

import { createHash } from 'node:crypto';
import { bool, deepFreeze, fail, int, oneOf, record, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-12: audience recruitment, registration, deterministic allocation, waitlist and check-in. */
export type Registration = Readonly<{ principalId: string; receivedAt: string; status: 'requested' | 'admitted' | 'waitlisted' | 'cancelled' | 'checked-in'; changedAt: string }>;
export type AdmissionState = Readonly<{ status: 'closed' | 'open' | 'allocated'; capacity: number; policy: 'first-come' | 'lottery'; lotterySeed: string | null; registrations: readonly Registration[] }>;
export function initialAdmission(): AdmissionState { return deepFreeze({ status: 'closed', capacity: 0, policy: 'first-come', lotterySeed: null, registrations: [] }); }

const occupying = (r: Registration) => r.status === 'admitted' || r.status === 'checked-in';
/** Deterministic order: arrival time (ties by id) or a published-seed lottery hash. */
export function allocationOrder(state: AdmissionState): readonly Registration[] {
  const active = state.registrations.filter((r) => r.status !== 'cancelled');
  const key = (r: Registration) => state.policy === 'lottery' ? createHash('sha256').update(`${state.lotterySeed}:${r.principalId}`).digest('hex') : `${r.receivedAt}:${r.principalId}`;
  return [...active].sort((a, b) => key(a).localeCompare(key(b)));
}
export function seatsRemaining(state: AdmissionState): number { return Math.max(0, state.capacity - state.registrations.filter(occupying).length); }

function promote(state: AdmissionState, now: string): AdmissionState {
  let remaining = seatsRemaining(state);
  if (state.status !== 'allocated' || remaining === 0) return state;
  const promoted = new Set<string>();
  for (const r of allocationOrder(state)) { if (remaining === 0) break; if (r.status === 'waitlisted') { promoted.add(r.principalId); remaining--; } }
  return deepFreeze({ ...state, registrations: state.registrations.map((r) => promoted.has(r.principalId) ? { ...r, status: 'admitted', changedAt: now } : r) });
}
function update(state: AdmissionState, principalId: string, change: (r: Registration) => Registration): AdmissionState {
  const current = state.registrations.find((r) => r.principalId === principalId) ?? fail('not_registered');
  return deepFreeze({ ...state, registrations: state.registrations.map((r) => r === current ? change(r) : r) });
}

export function applyAdmission(state: AdmissionState, type: string, input: unknown, context: Context): AdmissionState {
  switch (type) {
    case 'configure': {
      const p = record(input, ['capacity', 'policy', 'lotterySeed']);
      if (state.status === 'allocated') fail('already_allocated', 409);
      const policy = oneOf(p.policy, ['first-come', 'lottery'] as const, 'policy');
      const seed = p.lotterySeed === null ? null : typeof p.lotterySeed === 'string' && /^[a-f0-9]{64}$/.test(p.lotterySeed) ? p.lotterySeed : fail('invalid_seed', 400);
      if ((policy === 'lottery') !== (seed !== null)) fail('lottery_requires_published_seed', 400);
      return deepFreeze({ ...state, capacity: int(p.capacity, 'capacity', 1, 100000), policy, lotterySeed: seed });
    }
    case 'open': record(input, []); if (state.capacity < 1) fail('capacity_required'); if (state.status !== 'closed') fail('not_closed', 409); return deepFreeze({ ...state, status: 'open' });
    case 'register': {
      record(input, []);
      if (state.status === 'closed') fail('registration_closed', 409);
      const existing = state.registrations.find((r) => r.principalId === context.actor);
      if (existing && existing.status !== 'cancelled') fail('already_registered', 409);
      if (state.registrations.length >= 600 && !existing) fail('registration_full');
      const registration: Registration = { principalId: context.actor, receivedAt: context.now, status: state.status === 'allocated' ? 'waitlisted' : 'requested', changedAt: context.now };
      return promote(deepFreeze({ ...state, registrations: [...state.registrations.filter((r) => r.principalId !== context.actor), registration] }), context.now);
    }
    case 'cancel': {
      record(input, []);
      const next = update(state, context.actor, (r) => r.status === 'cancelled' || r.status === 'checked-in' ? fail('cannot_cancel', 409) : { ...r, status: 'cancelled', changedAt: context.now });
      return promote(next, context.now);
    }
    case 'allocate': {
      if (!bool(record(input, ['confirm']).confirm, 'confirm')) fail('confirmation_required', 400);
      if (state.status !== 'open') fail('not_open', 409);
      let seats = state.capacity;
      const decision = new Map(allocationOrder(state).map((r) => [r.principalId, seats-- > 0 ? 'admitted' as const : 'waitlisted' as const]));
      return deepFreeze({ ...state, status: 'allocated', registrations: state.registrations.map((r) => decision.has(r.principalId) ? { ...r, status: decision.get(r.principalId) ?? 'waitlisted', changedAt: context.now } : r) });
    }
    case 'checkIn': {
      const principalId = uuid(record(input, ['principalId']).principalId, 'principal');
      return update(state, principalId, (r) => r.status !== 'admitted' ? fail('not_admitted', 409) : { ...r, status: 'checked-in', changedAt: context.now });
    }
    case 'revoke': {
      const principalId = uuid(record(input, ['principalId']).principalId, 'principal');
      return promote(update(state, principalId, (r) => r.status === 'cancelled' ? fail('already_cancelled', 409) : { ...r, status: 'cancelled', changedAt: context.now }), context.now);
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'event.manage' | 'participant.self') => ({ action, apply: (s: AdmissionState, p: unknown, c: Context) => applyAdmission(s, type, p, c) });
export const admissionStream = defineStream<AdmissionState>({
  name: 'admission', readAction: 'event.manage', initial: initialAdmission,
  commands: { configure: cmd('configure', 'event.manage'), open: cmd('open', 'event.manage'), allocate: cmd('allocate', 'event.manage'), checkIn: cmd('checkIn', 'event.manage'),
    revoke: cmd('revoke', 'event.manage'), register: cmd('register', 'participant.self'), cancel: cmd('cancel', 'participant.self') },
  view: (state, actor) => {
    const mine = state.registrations.find((r) => r.principalId === actor) ?? null;
    const waitlist = allocationOrder(state).filter((r) => r.status === 'waitlisted');
    return { status: state.status, seatsRemaining: seatsRemaining(state), registration: mine,
      waitlistPosition: mine?.status === 'waitlisted' ? waitlist.findIndex((r) => r.principalId === actor) + 1 : null };
  },
});

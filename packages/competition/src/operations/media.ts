import { deepFreeze, fail, oneOf, record, str, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-16: remote participation and media-room control through a provider interface. */
export type MediaRole = 'debater' | 'moderator' | 'judge' | 'producer' | 'guest';
export type MediaProvider = Readonly<{
  name: string; configured: boolean;
  createRoom(roomId: string): Promise<{ providerRoomId: string }>;
  joinToken(providerRoomId: string, principalId: string, role: MediaRole, canPublish: boolean): Promise<string>;
  setMuted(providerRoomId: string, principalId: string, muted: boolean): Promise<void>;
  remove(providerRoomId: string, principalId: string): Promise<void>;
  endRoom(providerRoomId: string): Promise<void>;
}>;
/** Default when no media vendor credentials exist: every call fails closed with a clear code. */
export const disabledMediaProvider: MediaProvider = Object.freeze({
  name: 'disabled', configured: false,
  createRoom: async () => fail('media_provider_unconfigured', 409), joinToken: async () => fail('media_provider_unconfigured', 409),
  setMuted: async () => fail('media_provider_unconfigured', 409), remove: async () => fail('media_provider_unconfigured', 409), endRoom: async () => fail('media_provider_unconfigured', 409),
});
/** In-memory simulator for tests and demos only; clearly not a media service. */
export function simulatedMediaProvider() {
  const rooms = new Map<string, { muted: Set<string>; removed: Set<string>; ended: boolean }>();
  const room = (id: string) => rooms.get(id) ?? fail('unknown_room');
  const provider: MediaProvider & { rooms: typeof rooms } = {
    name: 'simulator', configured: true, rooms,
    createRoom: async (roomId) => { const id = `sim-${roomId}`; rooms.set(id, { muted: new Set(), removed: new Set(), ended: false }); return { providerRoomId: id }; },
    joinToken: async (id, principalId, role, canPublish) => { const r = room(id); if (r.ended || r.removed.has(principalId)) fail('join_denied', 403); return `sim.${id}.${principalId}.${role}.${canPublish ? 'pub' : 'sub'}`; },
    setMuted: async (id, principalId, muted) => { const r = room(id); if (muted) r.muted.add(principalId); else r.muted.delete(principalId); },
    remove: async (id, principalId) => { room(id).removed.add(principalId); },
    endRoom: async (id) => { room(id).ended = true; },
  };
  return provider;
}
/** Only debaters, moderators and producers publish; judges and guests watch. */
export const canPublish = (role: MediaRole) => role === 'debater' || role === 'moderator' || role === 'producer';

export type MediaParticipant = Readonly<{ principalId: string; role: MediaRole; muted: boolean; removed: boolean; reason: string | null }>;
export type MediaState = Readonly<{ status: 'none' | 'open' | 'ended'; provider: string | null; providerRoomId: string | null; participants: readonly MediaParticipant[] }>;
export function initialMedia(): MediaState { return deepFreeze({ status: 'none', provider: null, providerRoomId: null, participants: [] }); }

function member(state: MediaState, principalId: unknown): MediaParticipant {
  const id = uuid(principalId, 'principal');
  return state.participants.find((p) => p.principalId === id) ?? fail('unknown_participant');
}
function swap(state: MediaState, previous: MediaParticipant, next: MediaParticipant): MediaState {
  return deepFreeze({ ...state, participants: state.participants.map((p) => p === previous ? next : p) });
}
/** Records provider-confirmed room facts. The HTTP handler calls the provider first. */
export function applyMedia(state: MediaState, type: string, input: unknown, _context: Context): MediaState {
  switch (type) {
    case 'roomOpened': {
      const p = record(input, ['provider', 'providerRoomId']);
      if (state.status !== 'none') fail('room_exists', 409);
      return deepFreeze({ ...state, status: 'open', provider: str(p.provider, 'provider', 1, 40), providerRoomId: str(p.providerRoomId, 'room', 1, 200) });
    }
    case 'admit': {
      const p = record(input, ['principalId', 'role']);
      if (state.status !== 'open') fail('room_not_open', 409);
      const principalId = uuid(p.principalId, 'principal');
      if (state.participants.some((x) => x.principalId === principalId)) fail('already_admitted', 409);
      return deepFreeze({ ...state, participants: [...state.participants, { principalId, role: oneOf(p.role, ['debater', 'moderator', 'judge', 'producer', 'guest'] as const, 'role'), muted: false, removed: false, reason: null }].slice(-100) });
    }
    case 'mute': case 'unmute': {
      const p = record(input, ['principalId']); const target = member(state, p.principalId);
      if (target.removed) fail('participant_removed', 409);
      return swap(state, target, { ...target, muted: type === 'mute' });
    }
    case 'remove': {
      const p = record(input, ['principalId', 'reason']); const target = member(state, p.principalId);
      return swap(state, target, { ...target, removed: true, muted: true, reason: str(p.reason, 'reason', 5, 300) });
    }
    case 'roomEnded': record(input, []); if (state.status !== 'open') fail('room_not_open', 409); return deepFreeze({ ...state, status: 'ended' });
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, as = type) => ({ action: 'media.control' as const, apply: (s: MediaState, p: unknown, c: Context) => applyMedia(s, as, p, c) });
/** Clients request actions; the provider is called first and only confirmed facts are recorded. */
export function createMediaStream(provider: MediaProvider) {
  return defineStream<MediaState>({
    name: 'media', readAction: 'event.manage', initial: initialMedia,
    commands: { openRoom: cmd('openRoom', 'roomOpened'), admit: cmd('admit'), mute: cmd('mute'), unmute: cmd('unmute'), remove: cmd('remove'), endRoom: cmd('endRoom', 'roomEnded') },
    prepare: async (type, payload, state, context) => {
      const room = () => state.providerRoomId ?? fail('room_not_open', 409);
      if (type === 'openRoom') {
        record(payload, []);
        if (state.status !== 'none') fail('room_exists', 409);
        const created = await provider.createRoom(context.actor);
        return { provider: provider.name, providerRoomId: created.providerRoomId };
      }
      if (type === 'mute' || type === 'unmute') { const p = record(payload, ['principalId']); await provider.setMuted(room(), uuid(p.principalId, 'principal'), type === 'mute'); }
      if (type === 'remove') { const p = record(payload, ['principalId', 'reason']); await provider.remove(room(), uuid(p.principalId, 'principal')); }
      if (type === 'endRoom') { record(payload, []); await provider.endRoom(room()); }
      return payload;
    },
  });
}
export const mediaStream = createMediaStream(disabledMediaProvider);

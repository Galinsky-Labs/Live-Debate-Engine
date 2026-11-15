import { createHash } from 'node:crypto';
import { deepFreeze, fail, list, oneOf, record, uuid, type Context } from './common.js';
import { generateBallotKey, sealPrivateKey, type BallotPublicKey } from './ballot-crypto.js';
import { defineStream } from './stream.js';

/** E-21: poll orchestration with an irreversible electorate lock and ordered pre/post rounds. */
export type PollStatus = 'draft' | 'locked' | 'pre-open' | 'pre-closed' | 'post-open' | 'closed';
export type PollState = Readonly<{
  status: PollStatus; electorate: Readonly<{ digests: readonly string[]; count: number; digest: string | null; lockedAt: string | null; lockedBy: string | null }>;
  publicKey: BallotPublicKey | null; sealedKey: string | null; rounds: readonly Readonly<{ round: 'pre' | 'post'; event: 'open' | 'close'; at: string; by: string }>[];
}>;
export function initialPoll(): PollState {
  return deepFreeze({ status: 'draft', electorate: { digests: [], count: 0, digest: null, lockedAt: null, lockedBy: null }, publicKey: null, sealedKey: null, rounds: [] });
}
export function voterDigest(principalId: string): string { return createHash('sha256').update(`lde-electorate-v1|${principalId}`).digest('hex'); }
export function electorateDigest(digests: readonly string[]): string { return createHash('sha256').update(digests.join('\n')).digest('hex'); }
export const keyContext = (scope: Context['scope']) => `poll:${scope?.tenantId}:${scope?.eventId}:${scope?.entityId}`;
const ORDER: Readonly<Record<string, readonly [PollStatus, PollStatus]>> = {
  'open:pre': ['locked', 'pre-open'], 'close:pre': ['pre-open', 'pre-closed'], 'open:post': ['pre-closed', 'post-open'], 'close:post': ['post-open', 'closed'],
};
export function openRound(state: PollState): 'pre' | 'post' | null { return state.status === 'pre-open' ? 'pre' : state.status === 'post-open' ? 'post' : null; }

export function applyPoll(state: PollState, type: string, input: unknown, context: Context): PollState {
  switch (type) {
    case 'lockElectorate': {
      const p = record(input, ['principalIds', 'publicKey', 'sealedKey']);
      if (state.status !== 'draft') fail('electorate_locked', 409);
      const ids = list(p.principalIds, (x) => uuid(x, 'principal'), 'electorate', 1, 1200);
      if (new Set(ids).size !== ids.length) fail('duplicate_voter');
      const digests = ids.map(voterDigest).sort();
      const key = record(p.publicKey, ['n', 'e'], 'public_key');
      if (typeof key.n !== 'string' || typeof key.e !== 'string' || typeof p.sealedKey !== 'string') fail('invalid_key', 400);
      return deepFreeze({ ...state, status: 'locked', electorate: { digests, count: digests.length, digest: electorateDigest(digests), lockedAt: context.now, lockedBy: context.actor },
        publicKey: { n: key.n, e: key.e }, sealedKey: p.sealedKey });
    }
    case 'open': case 'close': {
      const round = oneOf(record(input, ['round']).round, ['pre', 'post'] as const, 'round');
      const [from, to] = ORDER[`${type}:${round}`] ?? fail('invalid_round', 400);
      if (state.status !== from) fail('round_order', 409);
      return deepFreeze({ ...state, status: to, rounds: [...state.rounds, { round, event: type, at: context.now, by: context.actor }] });
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'event.manage' | 'session.control') => ({ action, apply: (s: PollState, p: unknown, c: Context) => applyPoll(s, type, p, c) });
/** The issuer key is generated server-side at lock time and stored only sealed with the server secret. */
export function createPollStream(secret: string) {
  return defineStream<PollState>({
    name: 'poll', readAction: 'event.read', initial: initialPoll,
    commands: { lockElectorate: cmd('lockElectorate', 'event.manage'), open: cmd('open', 'session.control'), close: cmd('close', 'session.control') },
    prepare: async (type, payload, _state, context) => {
      if (type !== 'lockElectorate') return payload;
      const p = record(payload, ['principalIds']);
      const key = generateBallotKey();
      return { principalIds: p.principalIds, publicKey: key.publicKey, sealedKey: sealPrivateKey(key.privateJwk, secret, keyContext(context.scope)) };
    },
    // Clients never receive the sealed key, not even ciphertext.
    redact: (state) => ({ ...state, sealedKey: null }),
  });
}

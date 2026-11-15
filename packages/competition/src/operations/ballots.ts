import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { withCredential } from '../../../identity/src/broker.js';
import type { IdentityRuntime } from '../../../identity/src/http.js';
import { AccessError } from '../../../identity/src/broker.js';
import { HttpError, readJson } from '../http.js';
import { fail, oneOf, OperationError, record, uuid } from './common.js';
import { openPrivateKey, pseudonymOf, receiptOf, signBlinded, verifyCredential, type BallotPublicKey } from './ballot-crypto.js';
import { CHOICES, emptyMatrix, type Choice, type TransitionMatrix } from './outcome.js';
import { keyContext } from './poll.js';

export type Tally = Readonly<{ paired: TransitionMatrix; unpaired: Readonly<Record<string, number>>; issued: number; electorate: number; electorateDigest: string; receipts: readonly string[] }>;
export function parseTally(raw: unknown): Tally {
  const value = raw as { paired: Record<string, number>; unpaired: Record<string, number>; issued: number; electorate: number; electorateDigest: string; receipts: string[] };
  const paired = emptyMatrix() as Record<Choice, Record<Choice, number>>;
  for (const [key, n] of Object.entries(value.paired)) { const [a, b] = key.split(':') as [Choice, Choice]; if (!CHOICES.includes(a) || !CHOICES.includes(b)) throw new Error('Invalid tally'); paired[a][b] = Number(n); }
  return Object.freeze({ paired, unpaired: value.unpaired, issued: value.issued, electorate: value.electorate, electorateDigest: value.electorateDigest, receipts: value.receipts });
}

/** E-20 secret-ballot service: blind issuance to authenticated electors, anonymous casting. */
export class BallotService {
  constructor(private readonly pool: Pool, private readonly secret: string) {}
  issue(credential: string, tenantId: string, eventId: string, pollId: string, input: unknown) {
    const blinded = record(input, ['blinded'], 'issue').blinded;
    if (typeof blinded !== 'string' || !/^[A-Za-z0-9_-]{16,400}$/.test(blinded)) fail('invalid_blinded', 400);
    const scope = { tenantId: uuid(tenantId, 'tenant'), eventId: uuid(eventId, 'event'), entityId: uuid(pollId, 'poll') };
    return withCredential(this.pool, credential, async (client) => {
      const row = (await client.query<{ result: { publicKey: BallotPublicKey; sealedKey: string } }>('SELECT lde_competition.ballot_issue($1,$2,$3) AS result', [scope.tenantId, scope.eventId, scope.entityId])).rows[0];
      if (!row) fail('issuance_failed', 409);
      const key = openPrivateKey(row.result.sealedKey, this.secret, keyContext(scope));
      return { publicKey: row.result.publicKey, blindSignature: signBlinded(blinded, key) };
    });
  }
  async publicKey(tenantId: string, eventId: string, pollId: string): Promise<{ publicKey: BallotPublicKey; status: string } | null> {
    const row = (await this.pool.query<{ result: { publicKey: BallotPublicKey; status: string } | null }>('SELECT lde_competition.ballot_public_key($1,$2,$3) AS result', [uuid(tenantId, 'tenant'), uuid(eventId, 'event'), uuid(pollId, 'poll')])).rows[0];
    return row?.result ?? null;
  }
  /** No session: the credential is the only authority. Returns the voter's verifiable receipt. */
  async cast(tenantId: string, eventId: string, pollId: string, input: unknown): Promise<{ receipt: string }> {
    const p = record(input, ['token', 'signature', 'round', 'choice'], 'ballot');
    const round = oneOf(p.round, ['pre', 'post'] as const, 'round'); const choice = oneOf(p.choice, CHOICES, 'choice');
    const key = await this.publicKey(tenantId, eventId, pollId) ?? fail('unknown_poll', 404);
    if (typeof p.token !== 'string' || typeof p.signature !== 'string' || !verifyCredential(p.token, p.signature, key.publicKey)) fail('invalid_credential', 403);
    const pseudonym = pseudonymOf(p.token); const receipt = receiptOf(pseudonym, round, choice);
    await this.pool.query('SELECT lde_competition.ballot_cast($1,$2,$3,$4,$5,$6,$7)', [tenantId, eventId, pollId, round, pseudonym, choice, receipt]);
    return { receipt };
  }
  tally(credential: string, tenantId: string, eventId: string, pollId: string, publicBoard: boolean) {
    return withCredential(this.pool, credential, async (client) => {
      const row = (await client.query<{ result: unknown }>('SELECT lde_competition.ballot_tally($1,$2,$3,$4) AS result', [uuid(tenantId, 'tenant'), uuid(eventId, 'event'), uuid(pollId, 'poll'), publicBoard])).rows[0];
      return publicBoard ? row?.result : parseTally(row?.result);
    });
  }
}

const ID = '([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const ROUTE = new RegExp(`^/api/tenants/${ID}/events/${ID}/ballots/${ID}/(key|issue|cast|receipts|tally)$`);
export type BallotHttpRuntime = Readonly<{ handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> }>;
export function createBallotHttp(service: BallotService, identity: IdentityRuntime, origin: string): BallotHttpRuntime {
  return Object.freeze({ handle: async (request, response) => {
    let url: URL; try { url = new URL(request.url ?? '/', origin); } catch { return false; }
    const route = ROUTE.exec(url.pathname); if (!route) return false;
    const [, tenant = '', event = '', poll = '', action = ''] = route;
    const send = (status: number, value: unknown) => {
      const body = JSON.stringify(value);
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'content-length': Buffer.byteLength(body), 'x-request-id': randomUUID() });
      response.end(body);
    };
    try {
      const method = ['key', 'receipts', 'tally'].includes(action) ? 'GET' : 'POST';
      if (request.method !== method) throw new HttpError(405, 'method_not_allowed');
      if (url.search) throw new HttpError(400, 'invalid_request');
      if (method === 'POST' && (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site')) throw new HttpError(403, 'origin_denied');
      if (action === 'key') send(200, await service.publicKey(tenant, event, poll) ?? { error: 'unknown_poll' });
      else if (action === 'cast') {
        // Deliberately unauthenticated: a session cookie would link the voter to the ballot.
        if (request.headers.cookie) throw new HttpError(400, 'send_ballots_without_session_cookies');
        send(200, await service.cast(tenant, event, poll, await readJson(request)));
      } else {
        const actor = await identity.authenticate(request);
        if (action === 'issue') send(200, await service.issue(actor.token, tenant, event, poll, await readJson(request)));
        else send(200, await service.tally(actor.token, tenant, event, poll, action === 'receipts'));
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (error instanceof HttpError) send(error.status, { error: error.code });
      else if (error instanceof OperationError) send(error.status, { error: error.code });
      else if (error instanceof AccessError && error.status === 401) send(401, { error: 'authentication_required' });
      else if (error instanceof AccessError || code === '42501') send(404, { error: 'ballot_unavailable' });
      else if (code === '23505') send(409, { error: 'already_issued_or_cast' });
      else if (code === '55000') send(409, { error: 'poll_not_accepting' });
      else send(503, { error: 'ballot_unavailable' });
    }
    return true;
  } });
}

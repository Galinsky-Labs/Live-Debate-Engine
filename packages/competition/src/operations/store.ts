import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withCredential } from '../../../identity/src/broker.js';
import { canonicalJson } from '../../../contracts/src/canonical.js';
import { fail, int, oneOf, record, uuid, type Queryable } from './common.js';
import { applyCommand, type AnyStream } from './stream.js';

export type Envelope = { snapshot: { entityId: string; revision: number; data: { stream: string; action: string; state: unknown; updatedBy: string; updatedAt: string } }; contentHash: string };
type Result = { records?: Envelope[]; current?: Envelope | null; nextRevision?: number | null; replayed?: boolean };

function verified(result: unknown): Result {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid operation result');
  const output = result as Result;
  for (const envelope of [...(output.records ?? []), ...(output.current ? [output.current] : [])]) {
    const hash = createHash('sha256').update(canonicalJson(envelope.snapshot), 'utf8').digest('hex');
    if (hash !== envelope.contentHash) throw new Error('Operation snapshot integrity failure');
  }
  return output;
}
function redacted(stream: AnyStream, result: Result): Result {
  if (!stream.redact) return result;
  const strip = (envelope: Envelope): Envelope => ({ ...envelope, redacted: true, snapshot: { ...envelope.snapshot, data: { ...envelope.snapshot.data, state: stream.redact?.(envelope.snapshot.data.state) } } } as Envelope);
  return { ...result, ...(result.records ? { records: result.records.map(strip) } : {}), ...(result.current ? { current: strip(result.current) } : {}) };
}
async function canRead(client: PoolClient, stream: AnyStream, tenant: string, event: string, actor: string): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>('SELECT lde_security.has_access($1,$2,$3,$4) AS allowed', [stream.readAction, tenant, event, actor]);
  return result.rows[0]?.allowed === true;
}
function selfView(stream: AnyStream, envelope: Envelope | null | undefined, actor: string) {
  if (!envelope) return null;
  const view = stream.view ? stream.view(envelope.snapshot.data.state, actor) : null;
  return { entityId: envelope.snapshot.entityId, revision: envelope.snapshot.revision, view };
}

/** Credential-bound command execution: read current state, apply a fixed reducer, append. */
export class OperationStore {
  private readonly streams: ReadonlyMap<string, AnyStream>;
  constructor(private readonly pool: Pool, streams: readonly AnyStream[], private readonly clock: () => number = Date.now) {
    this.streams = new Map(streams.map((stream) => [stream.name, stream]));
  }
  names(): readonly string[] { return [...this.streams.keys()]; }
  stream(name: string): AnyStream {
    const stream = this.streams.get(name);
    if (!stream) fail('unknown_stream', 400);
    return stream;
  }
  records(credential: string, tenantId: string, eventId: string, streamName: string, entityId: string | null = null, beforeRevision = 2147483647) {
    const stream = this.stream(streamName);
    const tenant = uuid(tenantId, 'tenant'); const event = uuid(eventId, 'event');
    return withCredential(this.pool, credential, async (client) => {
      const response = await client.query<{ result: unknown }>('SELECT lde_competition.operation_records($1,$2,$3,$4,$5,$6) AS result',
        [tenant, event, stream.name, stream.readAction, entityId === null ? null : uuid(entityId, 'entity'), int(beforeRevision, 'revision', 1)]);
      return redacted(stream, verified(response.rows[0]?.result));
    });
  }
  /** Self-service read: only the stream's filtered view for the authenticated principal. */
  self(credential: string, tenantId: string, eventId: string, streamName: string, entityId: string, action: unknown) {
    const stream = this.stream(streamName);
    const selected = oneOf(action, ['participant.self', 'floor.participate', 'question.submit', 'scorecard.write-own'] as const, 'action');
    return withCredential(this.pool, credential, async (client, actor) => {
      const response = await client.query<{ result: unknown }>('SELECT lde_competition.operation_state($1,$2,$3,$4,$5) AS result',
        [uuid(tenantId, 'tenant'), uuid(eventId, 'event'), stream.name, selected, uuid(entityId, 'entity')]);
      return { current: selfView(stream, verified(response.rows[0]?.result).current, actor.principalId) };
    });
  }
  execute(credential: string, tenantId: string, eventId: string, streamName: string, entityId: string, input: unknown) {
    const stream = this.stream(streamName);
    const body = record(input, ['commandId', 'expectedRevision', 'type', 'payload'], 'command');
    const commandId = uuid(body.commandId, 'command');
    const expected = int(body.expectedRevision, 'revision', 0, 999);
    const tenant = uuid(tenantId, 'tenant'); const event = uuid(eventId, 'event'); const entity = uuid(entityId, 'entity');
    if (typeof body.type !== 'string' || !Object.hasOwn(stream.commands, body.type)) fail('unknown_command', 400);
    const action = stream.commands[body.type]?.action ?? fail('unknown_command', 400);
    return withCredential(this.pool, credential, async (client, actor) => {
      const current = verified((await client.query<{ result: unknown }>('SELECT lde_competition.operation_state($1,$2,$3,$4,$5) AS result',
        [tenant, event, stream.name, action, entity])).rows[0]?.result).current ?? null;
      const now = new Date(this.clock()).toISOString();
      const context = { actor: actor.principalId, now, scope: { tenantId: tenant, eventId: event, entityId: entity } };
      let state: unknown;
      if (current === null) {
        if (expected !== 0) fail('revision_conflict', 409);
        state = stream.initial({ entityId: entity, eventId: event, tenantId: tenant });
      } else {
        // An exact retry (revision already advanced by this command) is answered by the database replay.
        if (current.snapshot.revision !== expected && current.snapshot.revision !== expected + 1) fail('revision_conflict', 409);
        state = current.snapshot.revision === expected ? current.snapshot.data.state : null;
      }
      let payload: unknown = body.payload;
      if (state !== null && stream.prepare) payload = await stream.prepare(String(body.type), body.payload, state, context, client as unknown as Queryable);
      const next = state === null ? { state: {}, action } : applyCommand(stream, state, body.type, payload, context);
      const digest = createHash('sha256').update(canonicalJson({ type: body.type, payload: body.payload ?? null }), 'utf8').digest('hex');
      const saved = verified((await client.query<{ result: unknown }>('SELECT lde_competition.save_operation($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
        [tenant, event, stream.name, next.action, entity, expected, JSON.stringify(next.state), digest, commandId])).rows[0]?.result);
      if (await canRead(client, stream, tenant, event, actor.principalId)) return redacted(stream, saved);
      return { current: selfView(stream, saved.current, actor.principalId), replayed: saved.replayed ?? false };
    });
  }
}

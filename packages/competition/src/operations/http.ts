import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IdentityRuntime } from '../../../identity/src/http.js';
import { AccessError } from '../../../identity/src/broker.js';
import { HttpError, readJson } from '../http.js';
import { OperationError } from './common.js';
import type { OperationStore } from './store.js';

export type OperationsHttpRuntime = Readonly<{ handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> }>;
const ID = '([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const ROUTE = new RegExp(`^/api/tenants/${ID}/events/${ID}/operations/([a-z][a-z-]{1,39})(?:/${ID})?$`);

/** GET list/history (stream read action) or ?self=<action> filtered view; POST a typed command. */
export function createOperationsHttp(store: OperationStore, identity: IdentityRuntime, origin: string): OperationsHttpRuntime {
  return Object.freeze({ handle: async (request, response) => {
    let url: URL; try { url = new URL(request.url ?? '/', origin); } catch { return false; }
    if (!url.pathname.startsWith('/api/tenants/') || !url.pathname.includes('/operations/')) return false;
    const send = (status: number, value: unknown) => {
      const body = JSON.stringify(value);
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'content-length': Buffer.byteLength(body), 'x-request-id': randomUUID() });
      response.end(body);
    };
    try {
      const route = ROUTE.exec(url.pathname);
      if (!route) throw new HttpError(404, 'not_found');
      const [, tenant = '', event = '', stream = '', entity] = route;
      if (!['GET', 'POST'].includes(request.method ?? '')) throw new HttpError(405, 'method_not_allowed');
      if (request.method === 'POST' && (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site')) throw new HttpError(403, 'origin_denied');
      const actor = await identity.authenticate(request);
      if (request.method === 'GET') {
        const keys = [...url.searchParams.keys()];
        if (new Set(keys).size !== keys.length || keys.some((k) => !['before', 'self'].includes(k))) throw new HttpError(400, 'invalid_request');
        const self = url.searchParams.get('self');
        if (self !== null) {
          if (!entity) throw new HttpError(400, 'invalid_request');
          send(200, await store.self(actor.token, tenant, event, stream, entity, self)); return true;
        }
        const before = url.searchParams.get('before');
        if (before !== null && (!entity || !/^[1-9][0-9]{0,9}$/.test(before))) throw new HttpError(400, 'invalid_request');
        send(200, await store.records(actor.token, tenant, event, stream, entity ?? null, before === null ? 2147483647 : Number(before)));
      } else {
        if (url.search || !entity) throw new HttpError(400, 'invalid_request');
        send(200, await store.execute(actor.token, tenant, event, stream, entity, await readJson(request)));
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (error instanceof HttpError) send(error.status, { error: error.code });
      else if (error instanceof OperationError) send(error.status, { error: error.code });
      else if (error instanceof AccessError && error.status === 401) send(401, { error: 'authentication_required' });
      else if (error instanceof AccessError || code === '42501') send(404, { error: 'operation_unavailable' });
      else if (['40001', '40P01', '55P03', '55000', '23505'].includes(code)) send(409, { error: 'operation_conflict' });
      else if (code === '54000') send(413, { error: 'operation_limit_exceeded' });
      else if (['invalid_contract', '22023', '22P02', '23514', '23503', '23502'].includes(code)) send(400, { error: 'invalid_operation_request' });
      else send(503, { error: 'operation_unavailable' });
    }
    return true;
  } });
}

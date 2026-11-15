/**
 * E-37 Live Debate Engine SDK (dependency-free, browser and Node 22+).
 * PublicClient reads the versioned anonymous API; OperationsClient sends typed commands with the
 * caller's same-origin session; ballot helpers implement the blind-credential voter flow.
 */
export const SDK_API_VERSION = 'public-v1';
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export class EngineApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code); this.name = 'EngineApiError'; } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = (value: string, label: string) => { if (!UUID.test(value)) throw new TypeError(`Invalid ${label}`); return value; };

export type PublicEvent = Readonly<{ eventId: string; title: string; venue: string; broadcastMode: string; revision: number; phase: string | null;
  motion: Readonly<{ motionId: string; revision: number; wording: string; description: string; categories: readonly string[] }> | null;
  results: Readonly<{ version: number; resultsHash: string; announcedAt: string; audience: unknown; judges: unknown; advancement: unknown }> | null;
  transcript: readonly Readonly<{ offsetMs: number; durationMs: number; text: string; revision: number }>[] | null }>;

export class PublicClient {
  private readonly base: string;
  constructor(baseUrl: string, private readonly fetcher: Fetch = (input, init) => fetch(input, init)) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new TypeError('Engine URL must use HTTPS');
    this.base = url.origin;
  }
  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`${this.base}${path}`, { method: 'GET', credentials: 'omit', headers: { accept: 'application/json' }, redirect: 'error', ...(signal ? { signal } : {}) });
    const data = await response.json().catch(() => null) as { error?: string; apiVersion?: string } | null;
    if (!response.ok) throw new EngineApiError(response.status, data?.error ?? 'request_failed');
    if (data?.apiVersion !== SDK_API_VERSION && !(data && 'manifest' in data)) throw new EngineApiError(response.status, 'unsupported_api_version');
    return data as T;
  }
  async listEvents(tenantId: string, signal?: AbortSignal): Promise<readonly PublicEvent[]> {
    return (await this.get<{ events: PublicEvent[] }>(`/api/public/v1/tenants/${id(tenantId, 'tenant')}/events`, signal)).events;
  }
  async getEvent(tenantId: string, eventId: string, signal?: AbortSignal): Promise<PublicEvent> {
    return (await this.get<{ event: PublicEvent }>(`/api/public/v1/tenants/${id(tenantId, 'tenant')}/events/${id(eventId, 'event')}`, signal)).event;
  }
  async getPackage(tenantId: string, eventId: string, signal?: AbortSignal) {
    return this.get<{ manifest: { apiVersion: string; generatedAt: string; sha256: string; bytes: number }; body: unknown }>(`/api/public/v1/tenants/${id(tenantId, 'tenant')}/events/${id(eventId, 'event')}/package`, signal);
  }
}

/** Authenticated, same-origin command client for engine-hosted or proxied consoles. */
export class OperationsClient {
  constructor(private readonly origin: string, private readonly tenantId: string, private readonly eventId: string, private readonly fetcher: Fetch = (input, init) => fetch(input, init)) { id(tenantId, 'tenant'); id(eventId, 'event'); }
  private path(stream: string, entity?: string) {
    if (!/^[a-z][a-z-]{1,39}$/.test(stream)) throw new TypeError('Invalid stream');
    return `${this.origin}/api/tenants/${this.tenantId}/events/${this.eventId}/operations/${stream}${entity ? `/${id(entity, 'entity')}` : ''}`;
  }
  async command(stream: string, entity: string, type: string, payload: unknown, expectedRevision: number, commandId: string = crypto.randomUUID()) {
    const response = await this.fetcher(this.path(stream, entity), { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId, expectedRevision, type, payload }) });
    const data = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new EngineApiError(response.status, data?.error ?? 'request_failed');
    return data;
  }
  async records(stream: string, entity?: string) {
    const response = await this.fetcher(this.path(stream, entity), { method: 'GET', credentials: 'include' });
    const data = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new EngineApiError(response.status, data?.error ?? 'request_failed');
    return data;
  }
}

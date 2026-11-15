import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { openPrivateKey } from '../../competition/src/operations/ballot-crypto.js';
import { signWebhook } from './http.js';

/** Block delivery to loopback, private, link-local, CGNAT, multicast and metadata addresses (SSRF). */
export function privateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    if (a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80') || a.startsWith('ff')) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); return mapped ? privateAddress(mapped[1] ?? '') : false;
  }
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}
export const WEBHOOK_SECRET_CONTEXT = (subscriptionId: string) => `webhook:${subscriptionId}`;
type Claimed = { id: number; attempt: number; url: string; sealedSecret: string; subscriptionId: string; payload: Record<string, unknown> };
export type Resolver = (host: string) => Promise<readonly string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** Polls the outbox, signs each metadata-only payload and records the outcome with backoff. */
export class WebhookWorker {
  private timer: NodeJS.Timeout | null = null; private running = false;
  constructor(private readonly pool: Pool, private readonly secret: string, private readonly fetcher: typeof fetch = fetch, private readonly resolve: Resolver = defaultResolver, private readonly clock: () => number = Date.now) {}
  async deliver(item: Claimed): Promise<{ ok: boolean; status: number }> {
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || url.username || url.password) return { ok: false, status: 0 };
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.resolve(url.hostname).catch(() => []);
    if (addresses.length === 0 || addresses.some(privateAddress)) return { ok: false, status: 0 };
    const body = JSON.stringify({ deliveryId: item.id, attempt: item.attempt, ...item.payload });
    const signature = signWebhook(openPrivateKey(item.sealedSecret, this.secret, WEBHOOK_SECRET_CONTEXT(item.subscriptionId)), body, Math.floor(this.clock() / 1000));
    try {
      const response = await this.fetcher(url.href, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-lde-signature': signature, 'user-agent': 'LiveDebateEngine-Webhooks/1' }, body });
      await response.body?.cancel();
      return { ok: response.status >= 200 && response.status < 300, status: response.status };
    } catch { return { ok: false, status: 0 }; }
  }
  async tick(limit = 10): Promise<number> {
    if (this.running) return 0; this.running = true;
    try {
      const claimed = (await this.pool.query<{ result: Claimed[] }>('SELECT lde_competition.webhook_claim($1) AS result', [limit])).rows[0]?.result ?? [];
      for (const item of claimed) {
        const outcome = await this.deliver(item);
        await this.pool.query('SELECT lde_competition.webhook_ack($1,$2,$3)', [item.id, outcome.ok, outcome.status]);
      }
      return claimed.length;
    } finally { this.running = false; }
  }
  start(intervalMs = 30000): void { if (!this.timer) { this.timer = setInterval(() => { void this.tick().catch(() => console.error(JSON.stringify({ event: 'webhook_tick_failed' }))); }, intervalMs); this.timer.unref(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

import { fail } from './common.js';

/** Exact minor-unit arithmetic for prize and payout ledgers. Amounts are decimal strings. */
export type Amount = string;
export function amount(value: unknown, label = 'amount'): Amount {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(value)) fail(`invalid_${label}`, 400);
  return value;
}
export const sum = (values: readonly Amount[]): Amount => values.reduce((t, v) => t + BigInt(v), 0n).toString();
export const sub = (a: Amount, b: Amount): Amount => { const r = BigInt(a) - BigInt(b); if (r < 0n) fail('negative_balance'); return r.toString(); };
export const lte = (a: Amount, b: Amount) => BigInt(a) <= BigInt(b);
/**
 * Largest-remainder apportionment: shares proportional to integer weights, summing exactly to total.
 * Ties in remainder go to the earlier key in sorted order, so results are deterministic.
 */
export function apportion(total: Amount, parts: readonly Readonly<{ key: string; weight: number }>[]): Readonly<Record<string, Amount>> {
  const t = BigInt(total); const ordered = [...parts].sort((a, b) => a.key.localeCompare(b.key));
  const weightSum = BigInt(ordered.reduce((s, p) => { if (!Number.isSafeInteger(p.weight) || p.weight < 0) fail('invalid_weight', 400); return s + p.weight; }, 0));
  if (ordered.length === 0 || weightSum === 0n) fail('no_recipients');
  if (new Set(ordered.map((p) => p.key)).size !== ordered.length) fail('duplicate_recipient');
  const rows = ordered.map((p) => { const exact = t * BigInt(p.weight); return { key: p.key, base: exact / weightSum, remainder: exact % weightSum }; });
  let left = t - rows.reduce((s, r) => s + r.base, 0n);
  for (const r of [...rows].sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.key.localeCompare(b.key)))) { if (left === 0n) break; r.base += 1n; left -= 1n; }
  return Object.freeze(Object.fromEntries(rows.map((r) => [r.key, r.base.toString()])));
}

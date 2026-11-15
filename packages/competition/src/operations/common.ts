import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../contracts/src/canonical.js';

/** Domain rule violation. `status` maps to HTTP; messages never contain caller data. */
export class OperationError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 422 = 422) { super(code); this.name = 'OperationError'; }
}
export function fail(code: string, status: 400 | 403 | 404 | 409 | 422 = 422): never { throw new OperationError(code, status); }

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Context = Readonly<{ actor: string; now: string; scope?: Readonly<{ tenantId: string; eventId: string; entityId: string }> }>;
/** Minimal query surface handed to provider/prepare hooks inside the caller's credential transaction. */
export type Queryable = Readonly<{ query: <R extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]) => Promise<{ rows: R[] }> }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function uuid(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`invalid_${label}`, 400);
  return value;
}
export function instant(value: unknown, label = 'instant'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) fail(`invalid_${label}`, 400);
  return value;
}
export function str(value: unknown, label: string, min = 1, max = 500): string {
  if (typeof value !== 'string') fail(`invalid_${label}`, 400);
  const text = value.normalize('NFC').trim();
  if (text.length < min || text.length > max || /[\0‪-‮⁦-⁩]/.test(text)) fail(`invalid_${label}`, 400);
  return text;
}
export function int(value: unknown, label: string, min = 0, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`invalid_${label}`, 400);
  return value;
}
export function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) fail(`invalid_${label}`, 400);
  return value as T[number];
}
export function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`invalid_${label}`, 400);
  return value;
}
export function record(value: unknown, keys: readonly string[], label = 'payload'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`invalid_${label}`, 400);
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) fail(`invalid_${label}`, 400);
  return value as Record<string, unknown>;
}
export function list<T>(value: unknown, parse: (item: unknown, index: number) => T, label: string, min = 0, max = 500): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`invalid_${label}`, 400);
  return value.map(parse);
}
export function unique<T>(values: readonly T[], label: string): void {
  if (new Set(values).size !== values.length) fail(`duplicate_${label}`);
}
export function hashOf(value: unknown): string { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
export function ms(at: string): number { return Date.parse(at); }

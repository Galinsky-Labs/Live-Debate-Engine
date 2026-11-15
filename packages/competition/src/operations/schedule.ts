import { bool, deepFreeze, fail, instant, list, ms, oneOf, record, str, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-11: scheduling, production preparation and (preview-only) communications. */
export const ITEM_KINDS = ['rehearsal', 'call', 'doors', 'start', 'end', 'broadcast', 'other'] as const;
export const RESOURCE_KINDS = ['venue', 'crew', 'equipment'] as const;
export type ScheduleItem = Readonly<{ itemId: string; kind: typeof ITEM_KINDS[number]; label: string; startAt: string; endAt: string; resources: readonly Readonly<{ kind: typeof RESOURCE_KINDS[number]; resourceId: string }>[] }>;
export type ChecklistItem = Readonly<{ code: string; label: string; done: boolean; by: string | null; at: string | null }>;
export type Message = Readonly<{ messageId: string; audience: 'all' | 'debater' | 'judge' | 'audience' | 'crew'; subject: string; template: string; sendAt: string; status: 'draft' | 'approved' | 'cancelled'; approvedBy: string | null }>;
export type ScheduleState = Readonly<{ timeZone: string; items: readonly ScheduleItem[]; checklist: readonly ChecklistItem[]; messages: readonly Message[] }>;

export const TEMPLATE_VARIABLES = ['eventTitle', 'startLocal', 'venue', 'timeZone'] as const;
export function initialSchedule(): ScheduleState { return deepFreeze({ timeZone: 'UTC', items: [], checklist: [], messages: [] }); }

/** Required ordering: rehearsal/call before start, doors before start, start before end. */
export function chronologyProblems(state: ScheduleState): string[] {
  const at = (kind: string) => state.items.filter((i) => i.kind === kind).map((i) => ms(i.startAt));
  const start = at('start'); const end = at('end'); const problems: string[] = [];
  if (start.length !== 1) problems.push('exactly_one_start_required');
  if (end.length > 1) problems.push('at_most_one_end');
  const s = start[0];
  if (s !== undefined) {
    for (const kind of ['rehearsal', 'call', 'doors']) if (at(kind).some((t) => t > s)) problems.push(`${kind}_after_start`);
    if (end.some((e) => e <= s)) problems.push('end_not_after_start');
  }
  return problems;
}

/** Advisory clash detection across events of the same tenant (adapted from the E-11 draft, PR #21). */
export function resourceConflicts(bookings: readonly Readonly<{ eventId: string; item: ScheduleItem }>[]) {
  const clashes: { resourceKind: string; resourceId: string; eventA: string; eventB: string; overlapStartsAt: string; overlapEndsAt: string }[] = [];
  const rows = bookings.flatMap((b) => b.item.resources.map((r) => ({ eventId: b.eventId, r, start: ms(b.item.startAt), end: ms(b.item.endAt) })));
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i]; const b = rows[j];
    if (!a || !b || a.eventId === b.eventId || a.r.kind !== b.r.kind || a.r.resourceId !== b.r.resourceId || !(a.start < b.end && b.start < a.end)) continue;
    clashes.push({ resourceKind: a.r.kind, resourceId: a.r.resourceId, eventA: a.eventId, eventB: b.eventId,
      overlapStartsAt: new Date(Math.max(a.start, b.start)).toISOString(), overlapEndsAt: new Date(Math.min(a.end, b.end)).toISOString() });
  }
  return deepFreeze(clashes);
}

/** Render with a fixed variable allow-list; unknown placeholders are rejected, never passed through. */
export function renderMessage(template: string, variables: Readonly<Record<typeof TEMPLATE_VARIABLES[number], string>>): string {
  return template.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (_match, name: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) fail('unknown_template_variable', 400);
    return variables[name as typeof TEMPLATE_VARIABLES[number]].replace(/[<>]/g, '');
  });
}
/** Approved messages due at `now`. Delivery happens only through a configured Notifier. */
export function dueMessages(state: ScheduleState, now: string): readonly Message[] {
  return state.messages.filter((m) => m.status === 'approved' && ms(m.sendAt) <= ms(now));
}
export type Notifier = Readonly<{ configured: boolean; send(message: Message, body: string): Promise<void> }>;
export const disabledNotifier: Notifier = Object.freeze({ configured: false, send: async () => fail('notifier_unconfigured', 409) });

function zone(value: unknown): string {
  const name = str(value, 'time_zone', 1, 64);
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); } catch { fail('invalid_time_zone', 400); }
  return name;
}
export function applySchedule(state: ScheduleState, type: string, input: unknown, context: Context): ScheduleState {
  switch (type) {
    case 'setTimeZone': return deepFreeze({ ...state, timeZone: zone(record(input, ['timeZone']).timeZone) });
    case 'setItem': {
      const p = record(input, ['itemId', 'kind', 'label', 'startAt', 'endAt', 'resources']);
      const item: ScheduleItem = { itemId: uuid(p.itemId, 'item'), kind: oneOf(p.kind, ITEM_KINDS, 'kind'), label: str(p.label, 'label', 1, 120), startAt: instant(p.startAt), endAt: instant(p.endAt),
        resources: list(p.resources, (r) => { const x = record(r, ['kind', 'resourceId'], 'resource'); return { kind: oneOf(x.kind, RESOURCE_KINDS, 'resource_kind'), resourceId: str(x.resourceId, 'resource', 1, 80) }; }, 'resources', 0, 10) };
      if (ms(item.endAt) < ms(item.startAt) || ms(item.endAt) - ms(item.startAt) > 48 * 3600000) fail('invalid_interval', 400);
      const items = [...state.items.filter((i) => i.itemId !== item.itemId), item].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.itemId.localeCompare(b.itemId));
      if (items.length > 60) fail('too_many_items');
      const next = deepFreeze({ ...state, items });
      const problems = chronologyProblems(next).filter((x) => x !== 'exactly_one_start_required');
      if (problems.length) fail(`chronology:${problems.join(',')}`);
      return next;
    }
    case 'removeItem': {
      const itemId = uuid(record(input, ['itemId']).itemId, 'item');
      if (!state.items.some((i) => i.itemId === itemId)) fail('unknown_item');
      return deepFreeze({ ...state, items: state.items.filter((i) => i.itemId !== itemId) });
    }
    case 'setChecklistItem': {
      const p = record(input, ['code', 'label']);
      const c = str(p.code, 'code', 2, 40);
      if (!/^[a-z][a-z0-9-]+$/.test(c)) fail('invalid_code', 400);
      const existing = state.checklist.find((x) => x.code === c);
      const item = { code: c, label: str(p.label, 'label', 1, 200), done: existing?.done ?? false, by: existing?.by ?? null, at: existing?.at ?? null };
      return deepFreeze({ ...state, checklist: [...state.checklist.filter((x) => x.code !== c), item].slice(-80) });
    }
    case 'completeChecklistItem': {
      const p = record(input, ['code', 'done']);
      const item = state.checklist.find((x) => x.code === p.code) ?? fail('unknown_checklist_item');
      const done = bool(p.done, 'done');
      return deepFreeze({ ...state, checklist: state.checklist.map((x) => x === item ? { ...x, done, by: done ? context.actor : null, at: done ? context.now : null } : x) });
    }
    case 'draftMessage': {
      const p = record(input, ['messageId', 'audience', 'subject', 'template', 'sendAt']);
      const message: Message = { messageId: uuid(p.messageId, 'message'), audience: oneOf(p.audience, ['all', 'debater', 'judge', 'audience', 'crew'] as const, 'audience'),
        subject: str(p.subject, 'subject', 1, 150), template: str(p.template, 'template', 1, 5000), sendAt: instant(p.sendAt), status: 'draft', approvedBy: null };
      renderMessage(message.template, { eventTitle: 'x', startLocal: 'x', venue: 'x', timeZone: 'x' });
      const prior = state.messages.find((m) => m.messageId === message.messageId);
      if (prior && prior.status !== 'draft') fail('message_not_editable', 409);
      return deepFreeze({ ...state, messages: [...state.messages.filter((m) => m.messageId !== message.messageId), message].slice(-50) });
    }
    case 'approveMessage': case 'cancelMessage': {
      const id = uuid(record(input, ['messageId']).messageId, 'message');
      const message = state.messages.find((m) => m.messageId === id) ?? fail('unknown_message');
      if (type === 'approveMessage' && message.status !== 'draft') fail('message_not_draft', 409);
      if (type === 'cancelMessage' && message.status === 'cancelled') fail('message_cancelled', 409);
      const next: Message = type === 'approveMessage' ? { ...message, status: 'approved', approvedBy: context.actor } : { ...message, status: 'cancelled' };
      return deepFreeze({ ...state, messages: state.messages.map((m) => m === message ? next : m) });
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string) => ({ action: 'event.manage' as const, apply: (s: ScheduleState, p: unknown, c: Context) => applySchedule(s, type, p, c) });
export const scheduleStream = defineStream<ScheduleState>({
  name: 'schedule', readAction: 'event.read', initial: initialSchedule,
  commands: Object.fromEntries(['setTimeZone', 'setItem', 'removeItem', 'setChecklistItem', 'completeChecklistItem', 'draftMessage', 'approveMessage', 'cancelMessage'].map((t) => [t, cmd(t)])),
});

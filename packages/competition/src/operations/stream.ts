import type { Action } from '../../../contracts/src/access.js';
import { fail, type Context, type Queryable } from './common.js';

export type CommandDefinition<S> = Readonly<{
  /** Fixed access action the database re-authorizes for this command. */
  action: Action | 'participant.self' | 'floor.participate';
  apply: (state: S, payload: unknown, context: Context) => S;
}>;
export type StreamDefinition<S> = Readonly<{
  name: string;
  readAction: Action | 'participant.self';
  /** Initial state for a new entity in this stream (revision 0). */
  initial: (ids: Readonly<{ entityId: string; eventId: string; tenantId: string }>) => S;
  commands: Readonly<Record<string, CommandDefinition<S>>>;
  /** Filtered projection for callers without the stream read action (never the full state). */
  view?: (state: S, actor: string) => unknown;
  /** Removes secret material from every response (e.g. sealed issuer keys). */
  redact?: (state: S) => unknown;
  /** Optional provider side effect run before the reducer; returns the payload the reducer records. */
  prepare?: (type: string, payload: unknown, state: S, context: Context, db: Queryable) => Promise<unknown>;
}>;
export type AnyStream = StreamDefinition<any>;

export function defineStream<S>(definition: StreamDefinition<S>): StreamDefinition<S> {
  if (!/^[a-z][a-z-]{1,39}$/.test(definition.name)) throw new Error('Invalid stream name');
  return Object.freeze({ ...definition, commands: Object.freeze({ ...definition.commands }) });
}

/** Pure replay: apply a command to a stream state. Used by the store and by acceptance tests. */
export function applyCommand<S>(stream: StreamDefinition<S>, state: S, type: unknown, payload: unknown, context: Context): Readonly<{ state: S; action: string }> {
  if (typeof type !== 'string' || !Object.hasOwn(stream.commands, type)) fail('unknown_command', 400);
  const command = stream.commands[type];
  if (!command) fail('unknown_command', 400);
  return Object.freeze({ state: command.apply(state, payload, context), action: command.action });
}

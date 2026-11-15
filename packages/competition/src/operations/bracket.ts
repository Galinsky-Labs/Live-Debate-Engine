import { deepFreeze, fail, int, list, record, str, uuid, type Context } from './common.js';
import { apportion, type Amount } from './money.js';
import { defineStream } from './stream.js';

/** E-28 single-elimination brackets with seeding, byes and certified-result advancement; E-29 placements. */
export type Match = Readonly<{ matchId: string; round: number; slot: number; home: string | null; away: string | null; winner: string | null; eventId: string | null; resultsHash: string | null }>;
export type BracketState = Readonly<{ status: 'draft' | 'seeded' | 'complete'; teams: readonly Readonly<{ teamId: string; name: string; seed: number }>[]; rounds: number; matches: readonly Match[] }>;
export function initialBracket(): BracketState { return deepFreeze({ status: 'draft', teams: [], rounds: 0, matches: [] }); }

/** Standard seeding order for a power-of-two bracket: 1 v N, and top seeds meet as late as possible. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) { const n = order.length * 2 + 1; order = order.flatMap((s) => [s, n - s]); }
  return order;
}
const mid = (round: number, slot: number) => `r${round}s${slot}`;
function propagate(matches: Match[], rounds: number): Match[] {
  // Byes advance automatically; winners move to the next round's home/away by slot parity.
  for (let round = 1; round <= rounds; round++) {
    for (const m of matches.filter((x) => x.round === round)) {
      const auto = m.winner ?? (round === 1 && m.home && !m.away ? m.home : round === 1 && m.away && !m.home ? m.away : null);
      const index = matches.indexOf(m);
      if (auto && !m.winner) matches[index] = { ...m, winner: auto };
      const winner = matches[index]?.winner;
      if (!winner || round === rounds) continue;
      const nextSlot = Math.ceil(m.slot / 2); const ni = matches.findIndex((x) => x.round === round + 1 && x.slot === nextSlot);
      const next = matches[ni]; if (!next) continue;
      matches[ni] = m.slot % 2 === 1 ? { ...next, home: winner } : { ...next, away: winner };
    }
  }
  return matches;
}
export function applyBracket(state: BracketState, type: string, input: unknown, _context: Context): BracketState {
  switch (type) {
    case 'seed': {
      if (state.status !== 'draft') fail('already_seeded', 409);
      const teams = list(record(input, ['teams']).teams, (raw) => { const t = record(raw, ['teamId', 'name', 'seed'], 'team'); return { teamId: uuid(t.teamId, 'team'), name: str(t.name, 'name', 1, 120), seed: int(t.seed, 'seed', 1, 64) }; }, 'teams', 2, 64);
      if (new Set(teams.map((t) => t.teamId)).size !== teams.length || new Set(teams.map((t) => t.seed)).size !== teams.length || teams.some((t) => t.seed > teams.length)) fail('invalid_seeding');
      const size = 2 ** Math.ceil(Math.log2(teams.length)); const rounds = Math.log2(size); const order = seedOrder(size);
      const bySeed = new Map(teams.map((t) => [t.seed, t.teamId]));
      const matches: Match[] = [];
      for (let round = 1; round <= rounds; round++) for (let slot = 1; slot <= size / 2 ** round; slot++) {
        matches.push({ matchId: mid(round, slot), round, slot, home: round === 1 ? bySeed.get(order[(slot - 1) * 2] ?? 0) ?? null : null, away: round === 1 ? bySeed.get(order[(slot - 1) * 2 + 1] ?? 0) ?? null : null, winner: null, eventId: null, resultsHash: null });
      }
      return deepFreeze({ status: 'seeded', teams, rounds, matches: propagate(matches, rounds) });
    }
    case 'recordResult': {
      const p = record(input, ['matchId', 'winner', 'eventId', 'resultsHash']);
      if (state.status !== 'seeded') fail('bracket_not_active', 409);
      const m = state.matches.find((x) => x.matchId === p.matchId) ?? fail('unknown_match');
      if (m.winner) fail('match_decided', 409);
      if (!m.home || !m.away) fail('match_not_ready', 409);
      const winner = uuid(p.winner, 'team'); if (winner !== m.home && winner !== m.away) fail('winner_not_in_match');
      if (typeof p.resultsHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.resultsHash)) fail('certified_results_hash_required', 400);
      const matches = state.matches.map((x) => x === m ? { ...m, winner, eventId: uuid(p.eventId, 'event'), resultsHash: p.resultsHash as string } : x);
      const done = propagate(matches, state.rounds);
      const final = done.find((x) => x.round === state.rounds);
      return deepFreeze({ ...state, matches: done, status: final?.winner ? 'complete' : 'seeded' });
    }
    default: return fail('unknown_command', 400);
  }
}
/** Final placements: champion, runner-up, then losers by the round they fell (shared placement). */
export function placements(state: BracketState): readonly Readonly<{ place: number; teams: readonly string[] }>[] {
  if (state.status !== 'complete') fail('bracket_incomplete');
  const final = state.matches.find((m) => m.round === state.rounds);
  const champion = final?.winner ?? fail('bracket_incomplete');
  const result = [{ place: 1, teams: [champion] }]; let place = 2;
  for (let round = state.rounds; round >= 1; round--) {
    const losers = state.matches.filter((m) => m.round === round && m.home && m.away).map((m) => (m.winner === m.home ? m.away : m.home)).filter((t): t is string => !!t).sort();
    if (losers.length) { result.push({ place, teams: losers }); place += losers.length; }
  }
  return deepFreeze(result);
}
/** Placement budget split by place weights (bps); tied teams share the summed weights of the places they span. */
export function placementAwards(state: BracketState, budget: Amount, weightsBps: readonly number[]): Readonly<Record<string, Amount>> {
  const rows: { key: string; weight: number }[] = [];
  for (const group of placements(state)) {
    const span = weightsBps.slice(group.place - 1, group.place - 1 + group.teams.length).reduce((s, w) => s + w, 0);
    if (span === 0) continue;
    // Equal share of the spanned weight; multiply to keep integer weights.
    for (const team of group.teams) rows.push({ key: team, weight: span * (720720 / group.teams.length) });
  }
  return apportion(budget, rows);
}
const cmd = (type: string) => ({ action: 'event.manage' as const, apply: (s: BracketState, p: unknown, c: Context) => applyBracket(s, type, p, c) });
export const bracketStream = defineStream<BracketState>({ name: 'bracket', readAction: 'event.read', initial: initialBracket, commands: { seed: cmd('seed'), recordResult: cmd('recordResult') } });

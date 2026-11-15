import { bool, deepFreeze, fail, int, list, oneOf, record, str, unique, uuid, type Context } from './common.js';
import { defineStream } from './stream.js';

/** E-09: casting, teams, rosters and judge assignments for one event. */
export const ROSTER_ROLES = ['debater', 'judge', 'moderator', 'timekeeper', 'producer'] as const;
export type RosterRole = typeof ROSTER_ROLES[number];
export type Team = Readonly<{ teamId: string; name: string; side: 'for' | 'against'; members: readonly string[] }>;
export type Assignment = Readonly<{ principalId: string; role: RosterRole; teamId: string | null }>;
export type Conflict = Readonly<{ judgeId: string; principalId: string; reason: string }>;
export type RosterState = Readonly<{
  status: 'draft' | 'locked'; requiredJudges: number; teams: readonly Team[]; assignments: readonly Assignment[];
  conflicts: readonly Conflict[]; lockedAt: string | null; lockedBy: string | null;
  amendments: readonly Readonly<{ at: string; by: string; reason: string }>[];
}>;

export function initialRoster(): RosterState {
  return deepFreeze({ status: 'draft', requiredJudges: 3, teams: [], assignments: [], conflicts: [], lockedAt: null, lockedBy: null, amendments: [] });
}
function draft(state: RosterState): RosterState { if (state.status !== 'draft') fail('roster_locked', 409); return state; }

/** Full consistency check; returns the list of blocking problems (empty when lockable). */
export function rosterProblems(state: RosterState): string[] {
  const problems: string[] = [];
  for (const side of ['for', 'against'] as const) if (!state.teams.some((team) => team.side === side)) problems.push(`missing_${side}_team`);
  const debaters = state.assignments.filter((a) => a.role === 'debater');
  for (const team of state.teams) {
    if (team.members.length === 0) problems.push('empty_team');
    for (const member of team.members) if (!debaters.some((a) => a.principalId === member && a.teamId === team.teamId)) problems.push('team_member_not_cast');
  }
  for (const debater of debaters) if (!state.teams.some((team) => team.teamId === debater.teamId && team.members.includes(debater.principalId))) problems.push('debater_without_team');
  const judges = state.assignments.filter((a) => a.role === 'judge');
  if (judges.length < state.requiredJudges) problems.push('insufficient_judges');
  if (!state.assignments.some((a) => a.role === 'moderator')) problems.push('missing_moderator');
  for (const judge of judges) {
    if (debaters.some((d) => d.principalId === judge.principalId)) problems.push('judge_is_debater');
    if (state.conflicts.some((c) => c.judgeId === judge.principalId && debaters.some((d) => d.principalId === c.principalId))) problems.push('judge_conflict_of_interest');
  }
  return [...new Set(problems)].sort();
}

export function applyRoster(state: RosterState, type: string, input: unknown, context: Context): RosterState {
  if (type === 'setJudgeSeats') {
    const p = record(input, ['requiredJudges']);
    return deepFreeze({ ...draft(state), requiredJudges: int(p.requiredJudges, 'judges', 1, 21) });
  }
  if (type === 'setTeam') {
    const p = record(input, ['teamId', 'name', 'side', 'members']);
    const team: Team = { teamId: uuid(p.teamId, 'team'), name: str(p.name, 'team_name', 1, 120), side: oneOf(p.side, ['for', 'against'] as const, 'side'), members: list(p.members, (m) => uuid(m, 'principal'), 'members', 1, 8) };
    unique(team.members, 'member');
    const others = draft(state).teams.filter((t) => t.teamId !== team.teamId);
    if (others.some((t) => t.members.some((m) => team.members.includes(m)))) fail('member_on_two_teams');
    if (others.some((t) => t.name.toLocaleLowerCase('en-US') === team.name.toLocaleLowerCase('en-US'))) fail('duplicate_team_name');
    if (others.length >= 16) fail('too_many_teams');
    return deepFreeze({ ...state, teams: [...others, team].sort((a, b) => a.teamId.localeCompare(b.teamId)) });
  }
  if (type === 'removeTeam') {
    const teamId = uuid(record(input, ['teamId']).teamId, 'team');
    if (!draft(state).teams.some((t) => t.teamId === teamId)) fail('unknown_team');
    return deepFreeze({ ...state, teams: state.teams.filter((t) => t.teamId !== teamId), assignments: state.assignments.filter((a) => a.teamId !== teamId) });
  }
  if (type === 'assign') {
    const p = record(input, ['principalId', 'role', 'teamId']);
    const role = oneOf(p.role, ROSTER_ROLES, 'role');
    const assignment: Assignment = { principalId: uuid(p.principalId, 'principal'), role, teamId: p.teamId === null ? null : uuid(p.teamId, 'team') };
    if ((role === 'debater') !== (assignment.teamId !== null)) fail('only_debaters_have_teams', 400);
    if (assignment.teamId && !draft(state).teams.some((t) => t.teamId === assignment.teamId && t.members.includes(assignment.principalId))) fail('not_a_team_member');
    const existing = draft(state).assignments.filter((a) => a.principalId === assignment.principalId);
    if (existing.some((a) => a.role === role)) fail('already_assigned', 409);
    if ((role === 'judge' && existing.some((a) => a.role === 'debater')) || (role === 'debater' && existing.some((a) => a.role === 'judge'))) fail('judge_is_debater');
    if (state.assignments.length >= 200) fail('roster_too_large');
    return deepFreeze({ ...state, assignments: [...state.assignments, assignment] });
  }
  if (type === 'unassign') {
    const p = record(input, ['principalId', 'role']);
    const principalId = uuid(p.principalId, 'principal'); const role = oneOf(p.role, ROSTER_ROLES, 'role');
    if (!draft(state).assignments.some((a) => a.principalId === principalId && a.role === role)) fail('unknown_assignment');
    return deepFreeze({ ...state, assignments: state.assignments.filter((a) => !(a.principalId === principalId && a.role === role)) });
  }
  if (type === 'declareConflict') {
    const p = record(input, ['judgeId', 'principalId', 'reason']);
    const conflict: Conflict = { judgeId: uuid(p.judgeId, 'judge'), principalId: uuid(p.principalId, 'principal'), reason: str(p.reason, 'reason', 5, 500) };
    if (conflict.judgeId === conflict.principalId) fail('invalid_conflict', 400);
    if (state.conflicts.some((c) => c.judgeId === conflict.judgeId && c.principalId === conflict.principalId)) fail('duplicate_conflict', 409);
    return deepFreeze({ ...state, conflicts: [...state.conflicts, conflict] });
  }
  if (type === 'lock') {
    const p = record(input, ['confirm']);
    if (!bool(p.confirm, 'confirm')) fail('confirmation_required', 400);
    const problems = rosterProblems(draft(state));
    if (problems.length) fail(`roster_incomplete:${problems.join(',')}`);
    return deepFreeze({ ...state, status: 'locked', lockedAt: context.now, lockedBy: context.actor });
  }
  if (type === 'unlock') {
    const reason = str(record(input, ['reason']).reason, 'reason', 10, 1000);
    if (state.status !== 'locked') fail('roster_not_locked', 409);
    return deepFreeze({ ...state, status: 'draft', lockedAt: null, lockedBy: null, amendments: [...state.amendments, { at: context.now, by: context.actor, reason }] });
  }
  fail('unknown_command', 400);
}

const command = (type: string) => ({ action: 'event.manage' as const, apply: (s: RosterState, p: unknown, c: Context) => applyRoster(s, type, p, c) });
export const rosterStream = defineStream<RosterState>({
  name: 'roster', readAction: 'event.read', initial: initialRoster,
  commands: Object.fromEntries(['setJudgeSeats', 'setTeam', 'removeTeam', 'assign', 'unassign', 'declareConflict', 'lock', 'unlock'].map((t) => [t, command(t)])),
});

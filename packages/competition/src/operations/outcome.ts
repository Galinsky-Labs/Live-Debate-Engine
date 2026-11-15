import { deepFreeze } from './common.js';

/** E-22: deterministic outcome calculation over exact integers. */
export const CHOICES = ['for', 'against', 'undecided'] as const;
export type Choice = typeof CHOICES[number];
/** Paired transitions: matrix[pre][post] counts voters with valid ballots in both rounds. */
export type TransitionMatrix = Readonly<Record<Choice, Readonly<Record<Choice, number>>>>;
export function emptyMatrix(): TransitionMatrix { return { for: { for: 0, against: 0, undecided: 0 }, against: { for: 0, against: 0, undecided: 0 }, undecided: { for: 0, against: 0, undecided: 0 } }; }
export function addMatrices(...matrices: readonly TransitionMatrix[]): TransitionMatrix {
  const out = emptyMatrix() as Record<Choice, Record<Choice, number>>;
  for (const m of matrices) for (const a of CHOICES) for (const b of CHOICES) { const v = m[a][b]; if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('Invalid count'); out[a][b] += v; }
  return out;
}
export function matrixFromPairs(pairs: readonly Readonly<{ pre: Choice; post: Choice }>[]): TransitionMatrix {
  const out = emptyMatrix() as Record<Choice, Record<Choice, number>>;
  for (const p of pairs) out[p.pre][p.post] += 1;
  return out;
}
export type AudienceVerdict = Readonly<{
  basis: 'audience-swing'; cohort: number; preCounts: Record<Choice, number>; postCounts: Record<Choice, number>;
  gain: Readonly<{ for: number; against: number }>; decision: 'for' | 'against' | 'tie' | 'inconclusive'; explanation: readonly string[];
}>;
/**
 * Paired-valid cohort, denominator includes undecided. Because both rounds share one denominator,
 * comparing percentage-point gains is exactly comparing integer count gains — no rounding.
 */
export function audienceVerdict(matrix: TransitionMatrix): AudienceVerdict {
  const pre = { for: 0, against: 0, undecided: 0 }; const post = { for: 0, against: 0, undecided: 0 };
  for (const a of CHOICES) for (const b of CHOICES) { pre[a] += matrix[a][b]; post[b] += matrix[a][b]; }
  const cohort = pre.for + pre.against + pre.undecided;
  const gain = { for: post.for - pre.for, against: post.against - pre.against };
  const decision = cohort === 0 ? 'inconclusive' : gain.for > gain.against ? 'for' : gain.against > gain.for ? 'against' : 'tie';
  const explanation = [
    `Paired cohort: ${cohort} voters with valid pre and post ballots.`,
    `For: ${pre.for} -> ${post.for} (${gain.for >= 0 ? '+' : ''}${gain.for}); Against: ${pre.against} -> ${post.against} (${gain.against >= 0 ? '+' : ''}${gain.against}).`,
    decision === 'inconclusive' ? 'No paired ballots: inconclusive, held for review.' : decision === 'tie' ? 'Equal gains: tie.' : `Larger gain: ${decision}.`,
  ];
  return deepFreeze({ basis: 'audience-swing', cohort, preCounts: pre, postCounts: post, gain, decision, explanation });
}
/** Exact rational comparison (a/b vs c/d) without floating point. */
export function compareRational(a: Readonly<{ numerator: number; denominator: number }>, b: Readonly<{ numerator: number; denominator: number }>): -1 | 0 | 1 {
  const left = BigInt(a.numerator) * BigInt(b.denominator); const right = BigInt(b.numerator) * BigInt(a.denominator);
  return left < right ? -1 : left > right ? 1 : 0;
}
/** Advancement: audience is primary; a tie falls to the judges' decision (ruleset audienceTie='judges'). */
export function advancement(audience: AudienceVerdict['decision'], judges: 'for' | 'against' | 'tie' | 'inconclusive' | null, audienceTie: 'judges' | 'review' | 'rematch') {
  if (audience === 'for' || audience === 'against') return deepFreeze({ selectedSide: audience, reason: 'audience' as const });
  if (audience === 'tie' && audienceTie === 'judges' && (judges === 'for' || judges === 'against')) return deepFreeze({ selectedSide: judges, reason: 'judges-tiebreak' as const });
  return deepFreeze({ selectedSide: null, reason: audienceTie === 'rematch' && audience === 'tie' ? 'rematch' as const : 'review' as const });
}

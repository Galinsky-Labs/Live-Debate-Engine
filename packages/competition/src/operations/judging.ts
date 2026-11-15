import { deepFreeze } from './common.js';

/** E-25: exact rubric scoring, capped penalties/virtues and panel aggregation (BigInt rationals). */
export type Criterion = Readonly<{ code: string; label: string; weightBps: number; minimum: number; maximum: number }>;
export type Adjustment = Readonly<{ side: 'for' | 'against'; kind: 'penalty' | 'virtue'; points: number; finding: string; evidence: string }>;
export type CardEntries = Readonly<Record<'for' | 'against', Readonly<Record<string, number>>>>;
export type Caps = Readonly<{ penaltyMaxPerFinding: number; penaltyTotalCap: number; bonusMaxPerFinding: number; bonusTotalCap: number }>;
export type Rational = Readonly<{ numerator: string; denominator: string }>;

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
export function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new RangeError('Zero denominator');
  const sign = d < 0n ? -1n : 1n; const g = gcd(n, d) || 1n;
  return { numerator: ((n * sign) / g).toString(), denominator: ((d * sign) / g).toString() };
}
const r = (x: Rational) => [BigInt(x.numerator), BigInt(x.denominator)] as const;
export function add(a: Rational, b: Rational): Rational { const [an, ad] = r(a); const [bn, bd] = r(b); return rational(an * bd + bn * ad, ad * bd); }
export function cmp(a: Rational, b: Rational): -1 | 0 | 1 { const [an, ad] = r(a); const [bn, bd] = r(b); const x = an * bd; const y = bn * ad; return x < y ? -1 : x > y ? 1 : 0; }
export function divide(a: Rational, k: number): Rational { const [an, ad] = r(a); return rational(an, ad * BigInt(k)); }
export const ZERO = rational(0n, 1n);

export function rubricProblems(rubric: readonly Criterion[], entries: CardEntries): string[] {
  const problems: string[] = [];
  for (const side of ['for', 'against'] as const) {
    const scores = entries[side];
    if (Object.keys(scores).length !== rubric.length) problems.push(`incomplete_${side}`);
    for (const c of rubric) { const v = scores[c.code]; if (v === undefined || !Number.isSafeInteger(v) || v < c.minimum || v > c.maximum) problems.push(`invalid_${side}_${c.code}`); }
  }
  return problems;
}
export function adjustmentProblems(adjustments: readonly Adjustment[], caps: Caps): string[] {
  const problems: string[] = [];
  for (const side of ['for', 'against'] as const) {
    const pen = adjustments.filter((a) => a.side === side && a.kind === 'penalty'); const vir = adjustments.filter((a) => a.side === side && a.kind === 'virtue');
    if (pen.some((a) => a.points > caps.penaltyMaxPerFinding) || pen.reduce((s, a) => s + a.points, 0) > caps.penaltyTotalCap) problems.push(`penalty_cap_${side}`);
    if (vir.some((a) => a.points > caps.bonusMaxPerFinding) || vir.reduce((s, a) => s + a.points, 0) > caps.bonusTotalCap) problems.push(`virtue_cap_${side}`);
    const findings = adjustments.filter((a) => a.side === side).map((a) => a.finding.toLocaleLowerCase('en-US'));
    if (new Set(findings).size !== findings.length) problems.push(`double_counted_${side}`);
  }
  if (adjustments.some((a) => a.points < 1 || !a.evidence.trim())) problems.push('adjustment_requires_points_and_evidence');
  return problems;
}
/**
 * Side total on a 0..100 scale: Σ weight·(score−min)/(max−min) / 100 (weights sum to 10000 bps),
 * plus virtues minus penalties (points on the same 0..100 scale).
 */
export function sideTotal(rubric: readonly Criterion[], entries: CardEntries, adjustments: readonly Adjustment[], side: 'for' | 'against'): Rational {
  let total = ZERO;
  for (const c of rubric) total = add(total, rational(BigInt(c.weightBps) * BigInt((entries[side][c.code] ?? c.minimum) - c.minimum), BigInt(100 * (c.maximum - c.minimum))));
  const delta = adjustments.filter((a) => a.side === side).reduce((s, a) => s + (a.kind === 'virtue' ? a.points : -a.points), 0);
  return add(total, rational(BigInt(delta), 1n));
}
export type JudgeDecision = Readonly<{ judgeId: string; for: Rational; against: Rational; decision: 'for' | 'against' | 'tie' }>;
export function judgeDecision(judgeId: string, rubric: readonly Criterion[], entries: CardEntries, adjustments: readonly Adjustment[]): JudgeDecision {
  const f = sideTotal(rubric, entries, adjustments, 'for'); const a = sideTotal(rubric, entries, adjustments, 'against'); const c = cmp(f, a);
  return deepFreeze({ judgeId, for: f, against: a, decision: c > 0 ? 'for' : c < 0 ? 'against' : 'tie' });
}
export type PanelVerdict = Readonly<{ basis: 'judges-rubric'; aggregation: 'mean' | 'sum' | 'majority'; seats: number; submitted: number; forScore: Rational; againstScore: Rational; decision: 'for' | 'against' | 'tie' | 'inconclusive'; judges: readonly JudgeDecision[] }>;
/** All seats must be filled by submitted cards (ruleset allSeatsRequired); otherwise inconclusive. */
export function panelVerdict(decisions: readonly JudgeDecision[], seats: number, aggregation: 'mean' | 'sum' | 'majority'): PanelVerdict {
  const sum = (side: 'for' | 'against') => decisions.reduce((t, d) => add(t, d[side]), ZERO);
  const forScore = aggregation === 'mean' && decisions.length ? divide(sum('for'), decisions.length) : sum('for');
  const againstScore = aggregation === 'mean' && decisions.length ? divide(sum('against'), decisions.length) : sum('against');
  let decision: PanelVerdict['decision'];
  if (decisions.length < seats || seats === 0) decision = 'inconclusive';
  else if (aggregation === 'majority') {
    const f = decisions.filter((d) => d.decision === 'for').length; const a = decisions.filter((d) => d.decision === 'against').length;
    decision = f > a ? 'for' : a > f ? 'against' : 'tie';
  } else { const c = cmp(forScore, againstScore); decision = c > 0 ? 'for' : c < 0 ? 'against' : 'tie'; }
  return deepFreeze({ basis: 'judges-rubric', aggregation, seats, submitted: decisions.length, forScore, againstScore, decision, judges: [...decisions].sort((x, y) => x.judgeId.localeCompare(y.judgeId)) });
}

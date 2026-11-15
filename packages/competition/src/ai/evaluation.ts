/** E-42: evaluation laboratory — agreement, chance-corrected agreement, side bias and label metrics. */
export type Labelled = Readonly<{ itemId: string; human: 'for' | 'against' | 'tie'; ai: 'for' | 'against' | 'tie'; humanFallacies: readonly string[]; aiFallacies: readonly string[] }>;
export type Metrics = Readonly<{ n: number; accuracyBps: number; kappaBps: number; sideBiasBps: number; fallacyPrecisionBps: number; fallacyRecallBps: number }>;
const bps = (num: number, den: number) => (den === 0 ? 0 : Math.round((num * 10000) / den));
export function evaluate(rows: readonly Labelled[]): Metrics {
  const n = rows.length; const classes = ['for', 'against', 'tie'] as const;
  const agree = rows.filter((r) => r.human === r.ai).length;
  // Cohen's kappa: (po - pe) / (1 - pe), in basis points.
  const pe = n === 0 ? 0 : classes.reduce((s, c) => s + (rows.filter((r) => r.human === c).length / n) * (rows.filter((r) => r.ai === c).length / n), 0);
  const po = n === 0 ? 0 : agree / n;
  const kappa = pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
  const sideBias = n === 0 ? 0 : rows.filter((r) => r.ai === 'for').length / n - rows.filter((r) => r.human === 'for').length / n;
  let tp = 0; let fp = 0; let fn = 0;
  for (const r of rows) { const h = new Set(r.humanFallacies); const a = new Set(r.aiFallacies); for (const x of a) if (h.has(x)) tp++; else fp++; for (const x of h) if (!a.has(x)) fn++; }
  return Object.freeze({ n, accuracyBps: bps(agree, n), kappaBps: Math.round(kappa * 10000), sideBiasBps: Math.round(sideBias * 10000), fallacyPrecisionBps: bps(tp, tp + fp), fallacyRecallBps: bps(tp, tp + fn) });
}
/** Qualification thresholds; a provider that fails any of them cannot be certified. */
export const THRESHOLDS = Object.freeze({ minItems: 50, accuracyBps: 8000, kappaBps: 6000, maxAbsSideBiasBps: 1000, fallacyPrecisionBps: 6000 });
export function thresholdFailures(m: Metrics): readonly string[] {
  const f: string[] = [];
  if (m.n < THRESHOLDS.minItems) f.push('insufficient_items');
  if (m.accuracyBps < THRESHOLDS.accuracyBps) f.push('accuracy');
  if (m.kappaBps < THRESHOLDS.kappaBps) f.push('kappa');
  if (Math.abs(m.sideBiasBps) > THRESHOLDS.maxAbsSideBiasBps) f.push('side_bias');
  if (m.fallacyPrecisionBps < THRESHOLDS.fallacyPrecisionBps) f.push('fallacy_precision');
  return f;
}
/** Two-annotator agreement on decision labels (Cohen's kappa, bps) for dataset quality reporting. */
export function annotatorKappa(pairs: readonly Readonly<[string, string]>[]): number {
  return evaluate(pairs.map(([a, b], i) => ({ itemId: String(i), human: a as Labelled['human'], ai: b as Labelled['ai'], humanFallacies: [], aiFallacies: [] }))).kappaBps;
}

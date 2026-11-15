import { canonicalJson } from '../../../contracts/src/canonical.js';
import type { Criterion } from '../operations/judging.js';
import { judgeDecision } from '../operations/judging.js';
import { sha256, type Analysis, type AnalysisProvider, type Segment } from './analysis.js';

/** E-40: AI scorecards as reproducible, hash-bound evaluation artifacts. */
export type AiArtifact = Readonly<{
  provider: string; model: string; version: string; kind: string; qualified: false | true;
  inputHash: string; configHash: string; outputHash: string;
  entries: Readonly<Record<'for' | 'against', Readonly<Record<string, number>>>>; decision: 'for' | 'against' | 'tie'; rationale: readonly string[];
}>;
/** Map analysis features onto each rubric criterion's integer range deterministically. */
export function scoreFromAnalysis(rubric: readonly Criterion[], a: Analysis): Record<string, number> {
  const quality = 5 + Math.min(3, a.virtues.length) + Math.min(2, Math.floor(a.claims / 3)) + Math.min(1, a.rebuttals) - Math.min(4, a.fallacies.length * 2);
  const clamped = Math.max(0, Math.min(10, quality));
  return Object.fromEntries(rubric.map((c) => [c.code, c.minimum + Math.round(((c.maximum - c.minimum) * clamped) / 10)]));
}
export async function aiScorecard(provider: AnalysisProvider, rubric: readonly Criterion[], segments: readonly Segment[]): Promise<AiArtifact> {
  const inputHash = sha256(canonicalJson(segments));
  const configHash = sha256(canonicalJson({ provider: provider.id, model: provider.model, version: provider.version, rubric }));
  const analysis = await provider.analyze(segments);
  const entries = { for: scoreFromAnalysis(rubric, analysis.for), against: scoreFromAnalysis(rubric, analysis.against) };
  const decision = judgeDecision('ai', rubric, entries, []).decision;
  const rationale = (['for', 'against'] as const).map((side) => `${side}: ${analysis[side].claims} reasoning markers, ${analysis[side].rebuttals} rebuttals, virtues [${analysis[side].virtues.map((v) => v.label).join(', ')}], fallacies [${analysis[side].fallacies.map((f) => f.label).join(', ')}]`);
  const outputHash = sha256(canonicalJson({ entries, decision, rationale }));
  return Object.freeze({ provider: provider.id, model: provider.model, version: provider.version, kind: provider.kind, qualified: false, inputHash, configHash, outputHash, entries, decision, rationale });
}
/** Re-run a deterministic provider and confirm the artifact is reproduced bit-for-bit. */
export async function reproduce(provider: AnalysisProvider, rubric: readonly Criterion[], segments: readonly Segment[], artifact: AiArtifact): Promise<boolean> {
  if (!provider.deterministic) return false;
  const again = await aiScorecard(provider, rubric, segments);
  return again.inputHash === artifact.inputHash && again.configHash === artifact.configHash && again.outputHash === artifact.outputHash;
}

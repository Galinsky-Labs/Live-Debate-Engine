import { createHash } from 'node:crypto';

/**
 * E-39: argument analysis behind a provider interface. The only built-in provider is a
 * deterministic, rule-based baseline that is explicitly NOT an AI model and NOT qualified.
 */
export const FALLACIES = ['ad-hominem', 'straw-man', 'false-dilemma', 'slippery-slope', 'appeal-to-authority', 'hasty-generalization', 'appeal-to-emotion', 'whataboutism'] as const;
export const VIRTUES = ['evidence-cited', 'concession', 'direct-rebuttal', 'clarification', 'quantified-claim', 'civility'] as const;
export type Fallacy = typeof FALLACIES[number]; export type Virtue = typeof VIRTUES[number];
export type Finding<T extends string> = Readonly<{ label: T; segment: number; confidenceBps: number }>;
export type Analysis = Readonly<{ claims: number; rebuttals: number; fallacies: readonly Finding<Fallacy>[]; virtues: readonly Finding<Virtue>[] }>;
export type Segment = Readonly<{ side: 'for' | 'against'; text: string }>;
export type AnalysisProvider = Readonly<{
  id: string; model: string; version: string; kind: 'heuristic-baseline' | 'language-model'; configured: boolean; deterministic: boolean;
  analyze(segments: readonly Segment[]): Promise<Readonly<Record<'for' | 'against', Analysis>>>;
}>;

const RULES: readonly [Fallacy | Virtue, RegExp][] = [
  ['ad-hominem', /\b(you(?:'re| are) (?:an? )?(?:idiot|liar|fool|hypocrite)|my opponent is (?:dishonest|ignorant|a liar))\b/i],
  ['straw-man', /\b(so (?:what )?(?:you(?:'re| are)|my opponent is) (?:really |basically )?saying)\b/i],
  ['false-dilemma', /\b(either (?:we|you) .{0,60} or (?:we|you)|the only (?:alternative|option) is)\b/i],
  ['slippery-slope', /\b(next thing (?:you know|we know)|where does it end|will inevitably lead to)\b/i],
  ['appeal-to-authority', /\b(experts (?:all )?agree|everyone knows|as (?:a|the) (?:famous|renowned) [a-z]+ said)\b/i],
  ['hasty-generalization', /\b(all (?:of them|politicians|students|people like that) (?:are|always))\b/i],
  ['appeal-to-emotion', /\b(think of the children|imagine the (?:horror|suffering))\b/i],
  ['whataboutism', /\b(what about (?:when )?(?:you|your side|the other side))\b/i],
  ['evidence-cited', /\b(according to|study (?:by|from|in)|data (?:from|show)|published in|per cent|percent|statistics)\b/i],
  ['concession', /\b(i (?:concede|grant|accept) (?:that|the point)|my opponent is (?:right|correct) that|fair point)\b/i],
  ['direct-rebuttal', /\b(my opponent (?:claims|argued|said)|in response to|that argument fails because)\b/i],
  ['clarification', /\b(to be clear|let me clarify|what i mean is)\b/i],
  ['quantified-claim', /\b\d+(?:\.\d+)?\s?(?:%|percent|per cent|million|billion|thousand)\b/i],
  ['civility', /\b(thank you|with respect|i appreciate)\b/i],
];
/** Deterministic baseline: lexical rules only. Useful as a reproducible control, not as a judge. */
export const heuristicBaseline: AnalysisProvider = Object.freeze({
  id: 'heuristic-baseline', model: 'lde-lexical-rules', version: '1', kind: 'heuristic-baseline', configured: true, deterministic: true,
  async analyze(segments) {
    const out = { for: { claims: 0, rebuttals: 0, fallacies: [] as Finding<Fallacy>[], virtues: [] as Finding<Virtue>[] }, against: { claims: 0, rebuttals: 0, fallacies: [] as Finding<Fallacy>[], virtues: [] as Finding<Virtue>[] } };
    segments.forEach((s, segment) => {
      const side = out[s.side];
      side.claims += (s.text.match(/\b(because|therefore|so|thus|which means)\b/gi) ?? []).length;
      side.rebuttals += (s.text.match(/\b(however|but|on the contrary|that is false)\b/gi) ?? []).length;
      for (const [label, rule] of RULES) if (rule.test(s.text)) {
        if ((FALLACIES as readonly string[]).includes(label)) side.fallacies.push({ label: label as Fallacy, segment, confidenceBps: 5000 });
        else side.virtues.push({ label: label as Virtue, segment, confidenceBps: 5000 });
      }
    });
    return Object.freeze(out);
  },
});
/** Placeholder for a language-model provider: fails closed until a vendor, model and key are approved. */
export const unconfiguredModelProvider: AnalysisProvider = Object.freeze({
  id: 'language-model', model: 'unconfigured', version: '0', kind: 'language-model', configured: false, deterministic: false,
  async analyze() { throw new Error('analysis_provider_unconfigured'); },
});
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

import { deepFreeze, fail, int, record, str, uuid, type Context } from './common.js';
import { CHOICES, addMatrices, emptyMatrix, type TransitionMatrix } from './outcome.js';
import { defineStream } from './stream.js';

/** E-23: paper/keypad fallback with independent double entry and reconciliation against issued stock. */
export type Batch = Readonly<{ batchId: string; label: string; issued: number; entries: readonly Readonly<{ teller: string; matrix: TransitionMatrix; spoiled: number; at: string }>[]; status: 'open' | 'reconciled' | 'disputed' }>;
export type PaperState = Readonly<{ batches: readonly Batch[] }>;
export function initialPaper(): PaperState { return deepFreeze({ batches: [] }); }

function parseMatrix(value: unknown): TransitionMatrix {
  const m = record(value, [...CHOICES], 'matrix'); const out = emptyMatrix() as Record<string, Record<string, number>>;
  for (const a of CHOICES) { const row = record(m[a], [...CHOICES], 'matrix'); for (const b of CHOICES) (out[a] as Record<string, number>)[b] = int(row[b], 'count', 0, 100000); }
  return out as TransitionMatrix;
}
const total = (m: TransitionMatrix) => CHOICES.reduce((sum, a) => sum + CHOICES.reduce((s, b) => s + m[a][b], 0), 0);
const same = (a: TransitionMatrix, b: TransitionMatrix) => CHOICES.every((x) => CHOICES.every((y) => a[x][y] === b[x][y]));
/** Reconciled paired paper counts to combine with the electronic tally. */
export function reconciledMatrix(state: PaperState): TransitionMatrix {
  return addMatrices(emptyMatrix(), ...state.batches.filter((b) => b.status === 'reconciled').map((b) => b.entries[0]?.matrix ?? emptyMatrix()));
}
export function applyPaper(state: PaperState, type: string, input: unknown, context: Context): PaperState {
  switch (type) {
    case 'declareBatch': {
      const p = record(input, ['batchId', 'label', 'issued']);
      const batchId = uuid(p.batchId, 'batch');
      if (state.batches.some((b) => b.batchId === batchId)) fail('duplicate_batch', 409);
      if (state.batches.length >= 100) fail('too_many_batches');
      return deepFreeze({ batches: [...state.batches, { batchId, label: str(p.label, 'label', 1, 80), issued: int(p.issued, 'issued', 1, 100000), entries: [], status: 'open' }] });
    }
    case 'enterCount': {
      const p = record(input, ['batchId', 'matrix', 'spoiled']);
      const batch = state.batches.find((b) => b.batchId === p.batchId) ?? fail('unknown_batch');
      if (batch.status === 'reconciled') fail('batch_reconciled', 409);
      if (batch.entries.some((e) => e.teller === context.actor)) fail('teller_already_entered', 409);
      if (batch.entries.length >= 2) fail('batch_has_two_entries', 409);
      const matrix = parseMatrix(p.matrix); const spoiled = int(p.spoiled, 'spoiled', 0, 100000);
      if (total(matrix) + spoiled > batch.issued) fail('exceeds_issued_stock');
      const entries = [...batch.entries, { teller: context.actor, matrix, spoiled, at: context.now }];
      const first = entries[0];
      const status: Batch['status'] = entries.length < 2 || !first ? 'open' : same(first.matrix, matrix) && first.spoiled === spoiled ? 'reconciled' : 'disputed';
      return deepFreeze({ batches: state.batches.map((b) => b === batch ? { ...b, entries, status } : b) });
    }
    case 'resetDisputed': {
      const p = record(input, ['batchId', 'reason']); str(p.reason, 'reason', 10, 500);
      const batch = state.batches.find((b) => b.batchId === p.batchId && b.status === 'disputed') ?? fail('no_disputed_batch');
      return deepFreeze({ batches: state.batches.map((b) => b === batch ? { ...b, entries: [], status: 'open' } : b) });
    }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string) => ({ action: 'result.verify' as const, apply: (s: PaperState, p: unknown, c: Context) => applyPaper(s, type, p, c) });
export const paperStream = defineStream<PaperState>({
  name: 'paper', readAction: 'result.verify', initial: initialPaper,
  commands: { declareBatch: cmd('declareBatch'), enterCount: cmd('enterCount'), resetDisputed: cmd('resetDisputed') },
});

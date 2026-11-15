import { sourceManualProfile } from '../model.js';
import { bool, deepFreeze, fail, int, list, oneOf, record, str, uuid, type Context } from './common.js';
import type { Caps, Criterion } from './judging.js';
import { defineStream } from './stream.js';

/** E-24: judging panel configuration (rubric, caps, seats) fixed before scoring opens. */
export type PanelState = Readonly<{ status: 'draft' | 'open' | 'closed'; rubric: readonly Criterion[]; caps: Caps; aggregation: 'mean' | 'sum' | 'majority'; judges: readonly string[]; seats: number }>;
export function initialPanel(): PanelState {
  const rules = sourceManualProfile();
  return deepFreeze({ status: 'draft', rubric: rules.rubric.map((c) => ({ ...c })), caps: { penaltyMaxPerFinding: rules.adjustments.penaltyMaxPerFinding, penaltyTotalCap: rules.adjustments.penaltyTotalCap,
    bonusMaxPerFinding: rules.adjustments.bonusMaxPerFinding, bonusTotalCap: rules.adjustments.bonusTotalCap }, aggregation: rules.judging.aggregation, judges: [], seats: rules.judging.requiredSeats });
}
export function applyPanel(state: PanelState, type: string, input: unknown, _context: Context): PanelState {
  switch (type) {
    case 'configure': {
      const p = record(input, ['rubric', 'caps', 'aggregation', 'judges']);
      if (state.status !== 'draft') fail('panel_not_draft', 409);
      const rubric = list(p.rubric, (raw) => { const c = record(raw, ['code', 'label', 'weightBps', 'minimum', 'maximum'], 'criterion');
        const code = str(c.code, 'code', 2, 40); if (!/^[a-z][a-z0-9-]+$/.test(code)) fail('invalid_code', 400);
        return { code, label: str(c.label, 'label', 1, 120), weightBps: int(c.weightBps, 'weight', 1, 10000), minimum: int(c.minimum, 'minimum', 0, 1000), maximum: int(c.maximum, 'maximum', 1, 1000) }; }, 'rubric', 1, 20);
      if (rubric.reduce((s, c) => s + c.weightBps, 0) !== 10000 || rubric.some((c) => c.maximum <= c.minimum) || new Set(rubric.map((c) => c.code)).size !== rubric.length) fail('invalid_rubric');
      const k = record(p.caps, ['penaltyMaxPerFinding', 'penaltyTotalCap', 'bonusMaxPerFinding', 'bonusTotalCap'], 'caps');
      const caps = { penaltyMaxPerFinding: int(k.penaltyMaxPerFinding, 'cap', 0, 10), penaltyTotalCap: int(k.penaltyTotalCap, 'cap', 0, 100), bonusMaxPerFinding: int(k.bonusMaxPerFinding, 'cap', 0, 10), bonusTotalCap: int(k.bonusTotalCap, 'cap', 0, 100) };
      if (caps.penaltyTotalCap < caps.penaltyMaxPerFinding || caps.bonusTotalCap < caps.bonusMaxPerFinding) fail('invalid_caps');
      const judges = list(p.judges, (j) => uuid(j, 'judge'), 'judges', 1, 21);
      if (new Set(judges).size !== judges.length) fail('duplicate_judge');
      return deepFreeze({ ...state, rubric, caps, aggregation: oneOf(p.aggregation, ['mean', 'sum', 'majority'] as const, 'aggregation'), judges, seats: judges.length });
    }
    case 'open': if (!bool(record(input, ['confirm']).confirm, 'confirm')) fail('confirmation_required', 400); if (state.status !== 'draft' || state.judges.length === 0) fail('panel_not_ready', 409); return deepFreeze({ ...state, status: 'open' });
    case 'close': record(input, []); if (state.status !== 'open') fail('panel_not_open', 409); return deepFreeze({ ...state, status: 'closed' });
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string) => ({ action: 'event.manage' as const, apply: (s: PanelState, p: unknown, c: Context) => applyPanel(s, type, p, c) });
export const panelStream = defineStream<PanelState>({ name: 'panel', readAction: 'event.read', initial: initialPanel, commands: { configure: cmd('configure'), open: cmd('open'), close: cmd('close') } });

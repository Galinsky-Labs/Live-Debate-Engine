import { bool, deepFreeze, fail, oneOf, record, str, uuid, type Context, type Queryable } from './common.js';
import { amount, type Amount } from './money.js';
import type { PrizeState } from './prizes.js';
import { defineStream } from './stream.js';

/** E-31: payee onboarding and payout execution through a payment-provider interface. */
export type PaymentProvider = Readonly<{
  name: string; configured: boolean;
  onboardingLink(payeeId: string): Promise<{ providerAccountRef: string; url: string }>;
  submitPayout(idempotencyKey: string, providerAccountRef: string, currency: string, minorUnits: Amount): Promise<{ providerRef: string; status: 'submitted' | 'paid' }>;
}>;
/** Default with no payment keys: onboarding links and transfers fail closed. Manual settlement still works. */
export const disabledPaymentProvider: PaymentProvider = Object.freeze({
  name: 'disabled', configured: false,
  onboardingLink: async () => fail('payment_provider_unconfigured', 409),
  submitPayout: async () => fail('payment_provider_unconfigured', 409),
});
/** Deterministic in-memory simulator for tests; never moves money. */
export function simulatedPaymentProvider() {
  const submitted = new Map<string, string>();
  return Object.freeze({ name: 'simulator', configured: true, submitted,
    onboardingLink: async (payeeId: string) => ({ providerAccountRef: `sim_acct_${payeeId.slice(0, 8)}`, url: `https://payments.invalid/onboard/${payeeId}` }),
    submitPayout: async (key: string) => { const ref = submitted.get(key) ?? `sim_po_${submitted.size + 1}`; submitted.set(key, ref); return { providerRef: ref, status: 'submitted' as const }; } });
}

export type Payee = Readonly<{ principalId: string; onboarding: 'not-started' | 'pending' | 'verified' | 'rejected'; providerAccountRef: string | null; taxForm: 'missing' | 'received' | 'verified' }>;
export type Payout = Readonly<{ payoutId: string; obligationId: string; payee: string; currency: string; amount: Amount; status: 'requested' | 'approved' | 'submitted' | 'paid' | 'failed' | 'cancelled'; approvals: readonly string[]; providerRef: string | null; manualReference: string | null; history: readonly Readonly<{ at: string; by: string; status: string }>[] }>;
export type PayoutState = Readonly<{ payees: readonly Payee[]; payouts: readonly Payout[] }>;
export function initialPayouts(): PayoutState { return deepFreeze({ payees: [], payouts: [] }); }

function payee(state: PayoutState, id: string): Payee { return state.payees.find((p) => p.principalId === id) ?? { principalId: id, onboarding: 'not-started', providerAccountRef: null, taxForm: 'missing' }; }
function setPayee(state: PayoutState, next: Payee): PayoutState { return deepFreeze({ ...state, payees: [...state.payees.filter((p) => p.principalId !== next.principalId), next].slice(-300) }); }
function step(state: PayoutState, payoutId: unknown, from: readonly Payout['status'][], change: (p: Payout) => Partial<Payout>, context: Context): PayoutState {
  const p = state.payouts.find((x) => x.payoutId === payoutId) ?? fail('unknown_payout');
  if (!from.includes(p.status)) fail('invalid_payout_state', 409);
  const next = { ...p, ...change(p) };
  return deepFreeze({ ...state, payouts: state.payouts.map((x) => x === p ? { ...next, history: [...p.history, { at: context.now, by: context.actor, status: next.status }].slice(-20) } : x) });
}
export function applyPayouts(state: PayoutState, type: string, input: unknown, context: Context): PayoutState {
  switch (type) {
    case 'startOnboarding': {
      const p = record(input, ['providerAccountRef']);
      const current = payee(state, context.actor);
      if (current.onboarding === 'verified') fail('already_verified', 409);
      return setPayee(state, { ...current, onboarding: 'pending', providerAccountRef: str(p.providerAccountRef, 'account', 3, 200) });
    }
    case 'recordOnboarding': {
      const p = record(input, ['principalId', 'onboarding', 'taxForm']);
      const current = payee(state, uuid(p.principalId, 'principal'));
      if (current.principalId === context.actor) fail('self_verification_forbidden', 403);
      return setPayee(state, { ...current, onboarding: oneOf(p.onboarding, ['pending', 'verified', 'rejected'] as const, 'onboarding'), taxForm: oneOf(p.taxForm, ['missing', 'received', 'verified'] as const, 'tax_form') });
    }
    case 'request': {
      const p = record(input, ['payoutId', 'obligation']);
      const o = record(p.obligation, ['obligationId', 'recipient', 'amount', 'currency', 'status'], 'obligation');
      if (o.status !== 'approved') fail('obligation_not_approved');
      if (state.payouts.some((x) => x.obligationId === o.obligationId && x.status !== 'cancelled' && x.status !== 'failed')) fail('obligation_already_paid_or_pending', 409);
      const payout: Payout = { payoutId: uuid(p.payoutId, 'payout'), obligationId: str(o.obligationId, 'obligation', 8, 64), payee: uuid(o.recipient, 'recipient'), currency: str(o.currency, 'currency', 3, 3), amount: amount(o.amount),
        status: 'requested', approvals: [], providerRef: null, manualReference: null, history: [{ at: context.now, by: context.actor, status: 'requested' }] };
      if (state.payouts.length >= 300) fail('too_many_payouts');
      return deepFreeze({ ...state, payouts: [...state.payouts, payout] });
    }
    case 'approve': {
      const p = record(input, ['payoutId', 'confirm']);
      if (!bool(p.confirm, 'confirm')) fail('confirmation_required', 400);
      return step(state, p.payoutId, ['requested'], (x) => {
        if (x.payee === context.actor) fail('self_approval_forbidden', 403);
        if (x.approvals.includes(context.actor)) fail('already_approved', 409);
        const pe = payee(state, x.payee);
        if (pe.onboarding !== 'verified' || pe.taxForm !== 'verified') fail('payee_not_verified');
        const approvals = [...x.approvals, context.actor];
        return { approvals, status: approvals.length >= 2 ? 'approved' : 'requested' };
      }, context);
    }
    case 'submit': { const p = record(input, ['payoutId', 'providerRef']); return step(state, p.payoutId, ['approved'], () => ({ status: 'submitted', providerRef: str(p.providerRef, 'provider_ref', 3, 200) }), context); }
    case 'markPaid': {
      const p = record(input, ['payoutId', 'manualReference']);
      return step(state, p.payoutId, ['approved', 'submitted'], (x) => ({ status: 'paid', manualReference: x.status === 'approved' ? str(p.manualReference, 'reference', 5, 200) : null }), context);
    }
    case 'markFailed': { const p = record(input, ['payoutId', 'reason']); str(p.reason, 'reason', 5, 300); return step(state, p.payoutId, ['submitted'], () => ({ status: 'failed' }), context); }
    case 'cancel': { const p = record(input, ['payoutId', 'reason']); str(p.reason, 'reason', 5, 300); return step(state, p.payoutId, ['requested', 'approved'], () => ({ status: 'cancelled' }), context); }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'participant.self' | 'payout.approve' | 'prize.manage') => ({ action, apply: (s: PayoutState, p: unknown, c: Context) => applyPayouts(s, type, p, c) });
export function createPayoutsStream(provider: PaymentProvider) {
  return defineStream<PayoutState>({
    name: 'payouts', readAction: 'prize.manage', initial: initialPayouts,
    commands: { startOnboarding: cmd('startOnboarding', 'participant.self'), recordOnboarding: cmd('recordOnboarding', 'payout.approve'), request: cmd('request', 'prize.manage'),
      approve: cmd('approve', 'payout.approve'), submit: cmd('submit', 'payout.approve'), markPaid: cmd('markPaid', 'payout.approve'), markFailed: cmd('markFailed', 'payout.approve'), cancel: cmd('cancel', 'payout.approve') },
    prepare: async (type, payload, state, context, db: Queryable) => {
      if (type === 'startOnboarding') { record(payload, []); return { providerAccountRef: (await provider.onboardingLink(context.actor)).providerAccountRef }; }
      if (type === 'request') {
        const p = record(payload, ['payoutId', 'prizesId', 'obligationId']);
        const row = (await db.query<{ result: { records: { snapshot: { data: { state: PrizeState } } }[] } }>('SELECT lde_competition.operation_records($1,$2,$3,$4,$5,$6) AS result',
          [context.scope?.tenantId, context.scope?.eventId, 'prizes', 'prize.manage', uuid(p.prizesId, 'prizes'), 2147483647])).rows[0]?.result;
        const ledger = row?.records[0]?.snapshot.data.state ?? fail('unknown_prizes');
        const o = ledger.obligations.find((x) => x.obligationId === p.obligationId) ?? fail('unknown_obligation');
        return { payoutId: p.payoutId, obligation: { obligationId: o.obligationId, recipient: o.recipient, amount: o.amount, currency: ledger.currency, status: o.status } };
      }
      if (type === 'submit') {
        const p = record(payload, ['payoutId']);
        const x = state.payouts.find((y) => y.payoutId === p.payoutId) ?? fail('unknown_payout');
        const pe = state.payees.find((y) => y.principalId === x.payee);
        const sent = await provider.submitPayout(`lde-payout-${x.payoutId}`, pe?.providerAccountRef ?? fail('payee_not_onboarded'), x.currency, x.amount);
        return { payoutId: x.payoutId, providerRef: sent.providerRef };
      }
      return payload;
    },
    view: (state, actor) => ({ payee: state.payees.find((p) => p.principalId === actor) ?? null, payouts: state.payouts.filter((p) => p.payee === actor) }),
  });
}
export const payoutsStream = createPayoutsStream(disabledPaymentProvider);

import { deepFreeze, fail, int, list, oneOf, record, str, uuid, type Context } from './common.js';
import { amount, type Amount } from './money.js';
import { defineStream } from './stream.js';

/** E-35: access entitlements — tickets, memberships and supporter tiers. Paid checkout is provider-gated. */
export type Tier = Readonly<{ tierId: string; kind: 'ticket' | 'membership' | 'supporter'; name: string; currency: string; price: Amount; capacity: number | null; benefits: readonly string[]; active: boolean }>;
export type Grant = Readonly<{ grantId: string; principalId: string; tierId: string; status: 'pending-payment' | 'active' | 'revoked' | 'refunded'; source: 'complimentary' | 'free-claim' | 'payment'; checkoutRef: string | null; at: string }>;
export type AccessState = Readonly<{ tiers: readonly Tier[]; grants: readonly Grant[] }>;
export function initialAccess(): AccessState { return deepFreeze({ tiers: [], grants: [] }); }

export type CheckoutProvider = Readonly<{ name: string; configured: boolean; createCheckout(input: { grantId: string; principalId: string; currency: string; price: Amount; description: string }): Promise<{ checkoutRef: string; url: string }> }>;
export const disabledCheckoutProvider: CheckoutProvider = Object.freeze({ name: 'disabled', configured: false, createCheckout: async () => fail('payment_provider_unconfigured', 409) });
/** Deterministic test simulator; never charges. */
export function simulatedCheckoutProvider(): CheckoutProvider { return Object.freeze({ name: 'simulator', configured: true, createCheckout: async (i) => ({ checkoutRef: `sim_cs_${i.grantId.slice(0, 8)}`, url: `https://payments.invalid/checkout/${i.grantId}` }) }); }

const held = (s: AccessState, tierId: string) => s.grants.filter((g) => g.tierId === tierId && (g.status === 'active' || g.status === 'pending-payment')).length;
export function hasEntitlement(state: AccessState, principalId: string, kind?: Tier['kind']): boolean {
  return state.grants.some((g) => g.principalId === principalId && g.status === 'active' && (!kind || state.tiers.find((t) => t.tierId === g.tierId)?.kind === kind));
}
function newGrant(state: AccessState, tier: Tier, principalId: string, grantId: string, source: Grant['source'], checkoutRef: string | null, now: string): AccessState {
  if (!tier.active) fail('tier_inactive', 409);
  if (tier.capacity !== null && held(state, tier.tierId) >= tier.capacity) fail('sold_out', 409);
  if (state.grants.some((g) => g.principalId === principalId && g.tierId === tier.tierId && (g.status === 'active' || g.status === 'pending-payment'))) fail('already_entitled', 409);
  if (state.grants.length >= 800) fail('too_many_grants');
  return deepFreeze({ ...state, grants: [...state.grants, { grantId, principalId, tierId: tier.tierId, status: source === 'payment' ? 'pending-payment' : 'active', source, checkoutRef, at: now }] });
}
export function applyAccess(state: AccessState, type: string, input: unknown, context: Context): AccessState {
  const tier = (id: unknown) => state.tiers.find((t) => t.tierId === id) ?? fail('unknown_tier');
  const grant = (id: unknown) => state.grants.find((g) => g.grantId === id) ?? fail('unknown_grant');
  const setGrant = (g: Grant, status: Grant['status']) => deepFreeze({ ...state, grants: state.grants.map((x) => x === g ? { ...g, status } : x) });
  switch (type) {
    case 'setTier': {
      const p = record(input, ['tierId', 'kind', 'name', 'currency', 'price', 'capacity', 'benefits', 'active']);
      if (typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency)) fail('invalid_currency', 400);
      const t: Tier = { tierId: uuid(p.tierId, 'tier'), kind: oneOf(p.kind, ['ticket', 'membership', 'supporter'] as const, 'kind'), name: str(p.name, 'name', 1, 120), currency: p.currency, price: amount(p.price, 'price'),
        capacity: p.capacity === null ? null : int(p.capacity, 'capacity', 1, 100000), benefits: list(p.benefits, (b) => str(b, 'benefit', 1, 200), 'benefits', 0, 10), active: p.active === true };
      const prior = state.tiers.find((x) => x.tierId === t.tierId);
      if (prior && (prior.price !== t.price || prior.currency !== t.currency) && state.grants.some((g) => g.tierId === t.tierId)) fail('price_locked_after_sales', 409);
      if (!prior && state.tiers.length >= 20) fail('too_many_tiers');
      return deepFreeze({ ...state, tiers: [...state.tiers.filter((x) => x.tierId !== t.tierId), t] });
    }
    case 'grantComplimentary': { const p = record(input, ['grantId', 'tierId', 'principalId']); return newGrant(state, tier(p.tierId), uuid(p.principalId, 'principal'), uuid(p.grantId, 'grant'), 'complimentary', null, context.now); }
    case 'claim': {
      const p = record(input, ['grantId', 'tierId', 'checkoutRef']); const t = tier(p.tierId);
      if (t.price === '0') return newGrant(state, t, context.actor, uuid(p.grantId, 'grant'), 'free-claim', null, context.now);
      if (typeof p.checkoutRef !== 'string') fail('checkout_required', 409);
      return newGrant(state, t, context.actor, uuid(p.grantId, 'grant'), 'payment', p.checkoutRef, context.now);
    }
    case 'confirmPayment': { const g = grant(record(input, ['grantId', 'providerEventRef']).grantId); if (g.status !== 'pending-payment') fail('not_pending', 409); return setGrant(g, 'active'); }
    case 'revoke': { const p = record(input, ['grantId', 'reason']); str(p.reason, 'reason', 5, 300); const g = grant(p.grantId); if (g.status !== 'active' && g.status !== 'pending-payment') fail('not_active', 409); return setGrant(g, 'revoked'); }
    case 'refund': { const p = record(input, ['grantId', 'reason']); str(p.reason, 'reason', 5, 300); const g = grant(p.grantId); if (g.source !== 'payment' || g.status !== 'active') fail('not_refundable', 409); return setGrant(g, 'refunded'); }
    default: return fail('unknown_command', 400);
  }
}
const cmd = (type: string, action: 'event.manage' | 'participant.self' | 'prize.manage') => ({ action, apply: (s: AccessState, p: unknown, c: Context) => applyAccess(s, type, p, c) });
export function createAccessStream(provider: CheckoutProvider) {
  return defineStream<AccessState>({
    name: 'access', readAction: 'event.manage', initial: initialAccess,
    commands: { setTier: cmd('setTier', 'event.manage'), grantComplimentary: cmd('grantComplimentary', 'event.manage'), claim: cmd('claim', 'participant.self'),
      confirmPayment: cmd('confirmPayment', 'prize.manage'), revoke: cmd('revoke', 'event.manage'), refund: cmd('refund', 'prize.manage') },
    prepare: async (type, payload, state, context) => {
      if (type !== 'claim') return payload;
      const p = record(payload, ['grantId', 'tierId']);
      const t = state.tiers.find((x) => x.tierId === p.tierId) ?? fail('unknown_tier');
      if (t.price === '0') return { ...p, checkoutRef: null };
      const checkout = await provider.createCheckout({ grantId: uuid(p.grantId, 'grant'), principalId: context.actor, currency: t.currency, price: t.price, description: t.name });
      return { ...p, checkoutRef: checkout.checkoutRef };
    },
    view: (state, actor) => ({ tiers: state.tiers.filter((t) => t.active).map(({ capacity: _c, ...t }) => t), grants: state.grants.filter((g) => g.principalId === actor) }),
  });
}
export const accessStream = createAccessStream(disabledCheckoutProvider);

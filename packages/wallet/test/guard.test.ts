import { makePlan, NetworkUnavailable, type PaymentPlan, PolicyDenied, SubmitTimeout } from 'core';
import { MOCK_ASSET_ID, MOCK_FAIL_AMOUNT, MOCK_TIMEOUT_AMOUNT, MockWallet, mockInvoice } from 'core/mocks';
import { describe, expect, it } from 'vitest';
import { executeGuarded, MemoryGuardStore, RETRY_SAFE, WalletGuard } from '../src/guard.js';
import { walletTools } from '../src/tools.js';

const far = Math.floor(Date.parse('2100-01-01T00:00:00Z') / 1000);
const limits = { paymentCap: '100000000', assetAllowlist: [MOCK_ASSET_ID] };

async function setup(opts: { amount?: string; expiry?: number; state?: 'CONFIRMED' | 'AWAITING_CONFIRMATION' } = {}) {
  const wallet = new MockWallet({ stepMs: 0 });
  const amount = opts.amount ?? '25000000';
  const plan = await makePlan({
    invoiceId: 'inv-1',
    rgbInvoice: mockInvoice(undefined, undefined, opts.expiry ?? far),
    assetId: MOCK_ASSET_ID,
    amount,
    payee: { name: 'Acme Srl' },
    executeAt: 'now',
    labels: [],
  });
  const store = new MemoryGuardStore();
  store.put({
    plan,
    state: opts.state ?? 'CONFIRMED',
    confirmation: { planId: plan.planId, confirmedAt: new Date().toISOString() },
  });
  const guard = new WalletGuard({ store, wallet, limits });
  return { wallet, plan, store, guard, run: () => executeGuarded(plan.planId, { guard, wallet }) };
}

const outgoing = async (w: MockWallet) => (await w.listTransfers()).filter((t) => t.direction === 'outgoing');

describe('PaymentGuard', () => {
  it('pays a confirmed plan once and refuses the second execution', async () => {
    const s = await setup();
    const first = await s.run();
    expect(first).toMatchObject({ status: 'submitted', transferId: expect.any(String) });
    const second = await s.run();
    expect(second).toMatchObject({ status: 'failed', error: { code: 'already_executed' } });
    expect(await outgoing(s.wallet)).toHaveLength(1);
  });

  it('refuses unknown and unconfirmed plans', async () => {
    const s = await setup({ state: 'AWAITING_CONFIRMATION' });
    expect(await s.guard.check(s.plan.planId)).toMatchObject({ ok: false, reason: 'not_confirmed' });
    expect(await s.guard.check('f'.repeat(64))).toMatchObject({ ok: false, reason: 'unknown_plan' });
  });

  it('refuses a confirmation for another plan and a tampered plan', async () => {
    const s = await setup();
    s.store.put({ plan: s.plan, state: 'CONFIRMED', confirmation: { planId: 'a'.repeat(64), confirmedAt: 'x' } });
    expect(await s.guard.check(s.plan.planId)).toMatchObject({ ok: false, reason: 'not_confirmed' });
    const tampered: PaymentPlan = { ...s.plan, payee: { name: 'Evil Ltd' } };
    s.store.put({ plan: tampered, state: 'CONFIRMED', confirmation: { planId: s.plan.planId, confirmedAt: 'x' } });
    expect(await s.guard.check(s.plan.planId)).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    expect(await outgoing(s.wallet)).toHaveLength(0);
  });

  it('refuses over-cap, unapproved asset and insufficient funds', async () => {
    const over = await setup({ amount: '100000001' });
    expect(await over.guard.check(over.plan.planId)).toMatchObject({ ok: false, reason: 'over_cap' });

    const s = await setup();
    const strict = new WalletGuard({
      store: s.store,
      wallet: s.wallet,
      limits: { ...limits, assetAllowlist: ['rgb:x'] },
    });
    expect(await strict.check(s.plan.planId)).toMatchObject({ ok: false, reason: 'asset_not_allowed' });

    const poor = await setup({ amount: '90000000' });
    const big = new WalletGuard({
      store: poor.store,
      wallet: new MockWallet({ balance: '1000' }),
      limits,
    });
    expect(await big.check(poor.plan.planId)).toMatchObject({ ok: false, reason: 'insufficient_funds' });
    // the claim was released: with funds the same plan can run
    expect(await poor.guard.check(poor.plan.planId)).toMatchObject({ ok: true });
  });

  it('answers already_executed (not insufficient funds) while the first payment locks the change', async () => {
    const s = await setup({ amount: '600000000' });
    const slow = new MockWallet({ stepMs: 60_000 });
    const guard = new WalletGuard({ store: s.store, wallet: slow, limits: { ...limits, paymentCap: '900000000' } });
    expect(await executeGuarded(s.plan.planId, { guard, wallet: slow })).toMatchObject({ status: 'submitted' });
    expect(await executeGuarded(s.plan.planId, { guard, wallet: slow })).toMatchObject({
      error: { code: 'already_executed' },
    });
  });

  it('refuses a plan that would go over the daily limit (already sent today counts)', async () => {
    const s = await setup({ amount: '60000000' });
    await s.wallet.pay({
      rgbInvoice: mockInvoice(undefined, undefined, far),
      assetId: MOCK_ASSET_ID,
      amount: '100000000',
    });
    const daily = new WalletGuard({ store: s.store, wallet: s.wallet, limits: { ...limits, dailyCap: '150000000' } });
    expect(await daily.check(s.plan.planId)).toMatchObject({ ok: false, reason: 'over_cap' });
  });

  it('after a send timeout: no retry, result submitted with the transfer, plan stays claimed', async () => {
    const s = await setup({ amount: MOCK_TIMEOUT_AMOUNT });
    const r = await s.run();
    expect(r.status).toBe('submitted');
    expect(r.error).toBeUndefined();
    expect(await s.run()).toMatchObject({ status: 'failed', error: { code: 'already_executed' } });
    expect(await outgoing(s.wallet)).toHaveLength(1);
  });

  it('a failure before signing (expired invoice) frees the plan; an ambiguous failure does not', async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = await setup({ expiry: past });
    expect(await expired.run()).toMatchObject({ status: 'failed', error: { code: 'InvoiceExpired' } });
    expect(await expired.guard.check(expired.plan.planId)).toMatchObject({ ok: true });

    const failed = await setup({ amount: MOCK_FAIL_AMOUNT });
    expect(await failed.run()).toMatchObject({ status: 'failed', error: { code: 'TransferFailed' } });
    expect(await failed.guard.check(failed.plan.planId)).toMatchObject({ ok: false, reason: 'already_executed' });
  });
});

describe('PaymentGuard edge cases (M3.S2)', () => {
  it('double click: two executions at the same moment send exactly once', async () => {
    const s = await setup();
    const [a, b] = await Promise.all([s.run(), s.run()]);
    const results = [a, b].map((r) => r.status).sort();
    expect(results).toEqual(['failed', 'submitted']);
    expect([a, b].find((r) => r.status === 'failed')).toMatchObject({ error: { code: 'already_executed' } });
    expect(await outgoing(s.wallet)).toHaveLength(1);
  });

  it('plan changed after confirmation (amount, invoice, asset or date): refused, nothing sent', async () => {
    const s = await setup();
    const changes: Partial<PaymentPlan>[] = [
      { amount: '25000001' },
      { rgbInvoice: mockInvoice(undefined, undefined, far - 1) },
      { assetId: 'rgb:other' },
      { executeAt: '2100-01-01T00:00:00.000Z' },
    ];
    for (const change of changes) {
      s.store.put({
        plan: { ...s.plan, ...change },
        state: 'CONFIRMED',
        confirmation: { planId: s.plan.planId, confirmedAt: 'x' },
      });
      expect(await s.guard.check(s.plan.planId)).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    }
    expect(await outgoing(s.wallet)).toHaveLength(0);
  });

  it('a paid, rejected or failed invoice cannot run again through the guard', async () => {
    const s = await setup();
    for (const state of ['PAID', 'REJECTED', 'FAILED', 'AWAITING_CONFIRMATION'] as const) {
      s.store.put({ plan: s.plan, state, confirmation: { planId: s.plan.planId, confirmedAt: 'x' } });
      expect(await s.guard.check(s.plan.planId)).toMatchObject({ ok: false, reason: 'not_confirmed' });
    }
  });

  it('WDK policy refusal at signing: failed PolicyDenied, nothing sent, the plan is free again', async () => {
    const s = await setup();
    const denying = { pay: async () => Promise.reject(new PolicyDenied('The amount is above your payment limit.')) };
    const r = await executeGuarded(s.plan.planId, { guard: s.guard, wallet: denying });
    expect(r).toMatchObject({ status: 'failed', error: { code: 'PolicyDenied', message: /payment limit/ } });
    expect(await s.guard.check(s.plan.planId)).toMatchObject({ ok: true });
    expect(await outgoing(s.wallet)).toHaveLength(0);
  });

  it('balance unreadable (network down): refused as insufficient_funds with plain words, plan free', async () => {
    const s = await setup();
    const offline = {
      assetBalance: async () => Promise.reject(new NetworkUnavailable()),
      listTransfers: async () => [],
    };
    const guard = new WalletGuard({ store: s.store, wallet: offline, limits });
    expect(await guard.check(s.plan.planId)).toMatchObject({
      ok: false,
      reason: 'insufficient_funds',
      message: /could not read your balance/,
    });
    expect(await s.guard.check(s.plan.planId)).toMatchObject({ ok: true });
  });

  it('a SubmitTimeout without a transfer ID still keeps the claim (never resent)', async () => {
    const s = await setup();
    const r = await executeGuarded(s.plan.planId, {
      guard: s.guard,
      wallet: { pay: async () => Promise.reject(new SubmitTimeout()) },
    });
    expect(r).toEqual({ planId: s.plan.planId, status: 'submitted' });
    expect(await s.run()).toMatchObject({ error: { code: 'already_executed' } });
  });

  it('retry-safe codes never include a possibly-sent outcome', () => {
    for (const code of ['already_executed', 'SubmitTimeout', 'TransferFailed'])
      expect(RETRY_SAFE.has(code)).toBe(false);
    for (const code of ['PolicyDenied', 'policy_denied', 'over_cap', 'InsufficientFunds'])
      expect(RETRY_SAFE.has(code)).toBe(true);
  });
});

describe('walletTools', () => {
  it('exposes execute_plan (confirmation required), get_balance and create_receive_invoice with short args', async () => {
    const s = await setup();
    const [exec, bal, recv] = walletTools({ wallet: s.wallet, guard: s.guard });
    expect(exec.requiresConfirmation).toBe(true);
    expect(bal.requiresConfirmation).toBe(false);
    expect(exec.params.safeParse({ planId: 'not-a-plan' }).success).toBe(false);
    expect(await exec.handler({ planId: s.plan.planId })).toMatchObject({ status: 'submitted' });
    expect(await bal.handler({})).toEqual([
      expect.objectContaining({ assetId: MOCK_ASSET_ID, ticker: 'TUSDT', settled: '975000000' }),
    ]);
    expect(recv.params.safeParse({ amount: '1.5' }).success).toBe(false);
    const inv = (await recv.handler({ amount: '5000000', expiryMinutes: 60 })) as { rgbInvoice: string };
    expect(inv.rgbInvoice).toMatch(/^rgb:mock\//);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppEvent, makePlan } from 'core';
import { MOCK_TIMEOUT_AMOUNT, MockAnalyzer, MockTreasurer, MockWallet } from 'core/mocks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SqliteGuardStore } from '../src/guard-store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { GuardedMockTreasurer, LiveGuard } from '../src/providers.js';
import { type App, createApp } from '../src/server.js';
import { InvoiceStore } from '../src/store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiseledger-guard-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SqliteGuardStore', () => {
  it('claims atomically, survives a restart, release frees the claim; find resolves plan, state, confirmation', async () => {
    const dbPath = join(dir, 'app.db');
    const s1 = new InvoiceStore(dbPath);
    const at = new Date().toISOString();
    const plan = await makePlan({
      invoiceId: 'inv_1',
      rgbInvoice: 'mock:rgb:t:5000000:9999999999',
      assetId: 'rgb:t',
      amount: '5000000',
      payee: { name: 'Acme Srl' },
      executeAt: 'now',
      labels: [],
    });
    s1.insert({
      id: 'inv_1',
      state: 'CONFIRMED',
      filename: 'a.txt',
      kind: 'text',
      sha256: 'f',
      path: '/x',
      createdAt: at,
      updatedAt: at,
    });
    s1.update('inv_1', { plan, confirmation: { planId: plan.planId, confirmedAt: at } });
    const g1 = new SqliteGuardStore(s1);

    expect(await g1.find('0'.repeat(64))).toBeNull();
    expect(await g1.find(plan.planId)).toEqual({
      plan,
      state: 'CONFIRMED',
      confirmation: { planId: plan.planId, confirmedAt: at },
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => g1.claim(plan.planId)));
    expect(results.filter(Boolean)).toHaveLength(1);
    s1.close();

    const s2 = new InvoiceStore(dbPath);
    const g2 = new SqliteGuardStore(s2);
    expect(await g2.claim(plan.planId)).toBe(false);
    expect(g2.isClaimed(plan.planId)).toBe(true);
    await g2.release(plan.planId);
    expect(await g2.claim(plan.planId)).toBe(true);
    s2.close();
  });
});

describe('guarded execution on mocks', () => {
  let built: App;
  afterEach(async () => {
    await built.app.close();
  });

  async function waitForState(id: string, states: string[], timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = built.store.get(id)?.state as string;
      if (states.includes(state) || Date.now() > deadline) return state;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('a second execution of the same plan is refused (already_executed); one outgoing transfer; transfers listed with status', async () => {
    // Mock steps of 300 ms: the first payment stays in flight long enough to retry it.
    built = await createApp({ uploadDir: dir, dbPath: ':memory:', mockStepMs: 300 });
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/invoices',
      payload: { text: 'Invoice 2026-042, Acme Srl, 25.00 TUSDT', filename: 'ok.txt' },
    });
    const id = res.json().invoiceId as string;
    expect(await waitForState(id, ['AWAITING_CONFIRMATION'])).toBe('AWAITING_CONFIRMATION');
    const planId = built.store.get(id)?.plan?.planId as string;
    const ok = await built.app.inject({ method: 'POST', url: `/api/invoices/${id}/confirm`, payload: { planId } });
    expect(ok.statusCode).toBe(200);
    const wallet = built.providers.wallet as MockWallet;
    const outgoingNow = async () => (await wallet.listTransfers()).filter((t) => t.direction === 'outgoing');
    while ((await outgoingNow()).length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(built.store.get(id)?.state).toBe('EXECUTING');

    // Second execution of the same plan while the first is in flight (e.g. a retried tool call): refused.
    const inv = built.store.get(id);
    const plan = inv?.plan as NonNullable<NonNullable<typeof inv>['plan']>;
    const confirmation = inv?.confirmation as { planId: string; confirmedAt: string };
    const events: AppEvent[] = [];
    const second = await built.providers.treasurer.execute(plan, confirmation, (e) => events.push(e));
    expect(second).toMatchObject({ planId, status: 'failed', error: { code: 'already_executed' } });
    expect(events.some((e) => e.type === 'toolCall' && e.status === 'rejected')).toBe(true);

    expect(await waitForState(id, ['PAID', 'FAILED'])).toBe('PAID');
    // After PAID: a second confirm is refused by the state machine, a third execution by the guard.
    const again = await built.app.inject({ method: 'POST', url: `/api/invoices/${id}/confirm`, payload: { planId } });
    expect(again.statusCode).toBe(409);
    expect((await built.providers.treasurer.execute(plan, confirmation, () => undefined)).status).toBe('failed');

    const outgoing = await outgoingNow();
    expect(outgoing).toHaveLength(1);

    const transfers = (await built.app.inject({ method: 'GET', url: '/api/transfers' })).json().transfers as {
      transferId: string;
      status: string;
      invoiceId?: string;
      direction: string;
    }[];
    const paid = transfers.find((t) => t.invoiceId === id);
    expect(paid).toMatchObject({ transferId: outgoing[0]?.transferId, status: 'Settled', direction: 'out' });
    expect(transfers.every((t) => typeof t.status === 'string')).toBe(true);
  });

  it('POST /api/wallet/receive defaults to 24 h and no asset', async () => {
    built = await createApp({ uploadDir: dir, dbPath: ':memory:', mockStepMs: 0 });
    const before = Date.now();
    const res = await built.app.inject({ method: 'POST', url: '/api/wallet/receive', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assetId).toBeUndefined();
    const hours = (Date.parse(body.expiresAt) - before) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });
});

describe('SubmitTimeout', () => {
  it('stays EXECUTING (never FAILED, never resent); the next sync links the transfer by rgbInvoice and moves it to PAID', async () => {
    const store = new InvoiceStore(':memory:');
    const wallet = new MockWallet({ stepMs: 0 });
    await wallet.init();
    const guardStore = new SqliteGuardStore(store);
    const guard = new LiveGuard({ store: guardStore, wallet, config: loadConfig({}) });
    const treasurer = new GuardedMockTreasurer(new MockTreasurer(wallet, { pollMs: 10 }), guard);
    const orch = new Orchestrator({
      store,
      analyzer: new MockAnalyzer({ amount: MOCK_TIMEOUT_AMOUNT, stageDelayMs: 0 }),
      treasurer,
      wallet,
      uploadDir: dir,
    });
    const inv = await orch.createInvoice({ filename: 'timeout.txt', data: Buffer.from('Invoice, 13.14 TUSDT') });
    await orch.idle();
    const planId = store.get(inv.id)?.plan?.planId as string;
    await orch.confirm(inv.id, { planId });
    await orch.idle();

    const after = store.get(inv.id);
    expect(after?.state).toBe('EXECUTING');
    expect(after?.result).toMatchObject({ status: 'submitted', error: { code: 'SubmitTimeout' } });
    expect(after?.result?.transferId).toBeUndefined();
    expect(guardStore.isClaimed(planId)).toBe(true);

    const report = await orch.settleFromTransfers();
    expect(report).toMatchObject({ paid: [inv.id], linked: [inv.id], failed: [] });
    const settled = store.get(inv.id);
    expect(settled?.state).toBe('PAID');
    const transferId = settled?.result?.transferId as string;
    expect(settled?.result).toMatchObject({ status: 'settled', transferId });
    expect(store.invoiceForTransfer(transferId)).toBe(inv.id);
    const events = store.eventsOf(inv.id);
    expect(events.some((e) => e.type === 'transfer' && e.transferId === transferId && e.status === 'Settled')).toBe(
      true,
    );
    expect(events.filter((e) => e.type === 'state').map((e) => (e as { to: string }).to)).toContain('PAID');
    expect((await wallet.listTransfers()).filter((t) => t.direction === 'outgoing')).toHaveLength(1);

    // Idempotent: a second pass changes nothing.
    expect(await orch.settleFromTransfers()).toEqual({ paid: [], failed: [], linked: [], pending: [] });
    store.close();
  });

  it('a transfer that fails on chain moves the invoice to FAILED', async () => {
    const store = new InvoiceStore(':memory:');
    const wallet = new MockWallet({ stepMs: 0 });
    await wallet.init();
    const guard = new LiveGuard({ store: new SqliteGuardStore(store), wallet, config: loadConfig({}) });
    const treasurer = new GuardedMockTreasurer(new MockTreasurer(wallet, { follow: false }), guard);
    const orch = new Orchestrator({
      store,
      analyzer: new MockAnalyzer({ stageDelayMs: 0 }),
      treasurer,
      wallet,
      uploadDir: dir,
    });
    const inv = await orch.createInvoice({ filename: 'ok.txt', data: Buffer.from('Invoice') });
    await orch.idle();
    await orch.confirm(inv.id, { planId: store.get(inv.id)?.plan?.planId as string });
    await orch.idle();
    expect(store.get(inv.id)?.state).toBe('EXECUTING');
    const transferId = store.get(inv.id)?.result?.transferId as string;
    const failed = { ...(await wallet.getTransfer(transferId)), status: 'Failed' as const };
    wallet.getTransfer = async () => failed as never;
    wallet.listTransfers = async () => [failed as never];
    expect((await orch.settleFromTransfers()).failed).toEqual([inv.id]);
    expect(store.get(inv.id)?.state).toBe('FAILED');
    store.close();
  });
});

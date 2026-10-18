// Incoming payments: requests remembered on POST /api/wallet/receive, matched to incoming transfers after sync.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransferInfo } from 'core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteReceiveStore } from '../src/receives.js';
import { type App, createApp } from '../src/server.js';
import { InvoiceStore } from '../src/store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiseledger-rcv-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const T0 = new Date('2026-10-17T10:00:00.000Z');

function incoming(status: TransferInfo['status'], extra: Partial<TransferInfo> = {}): TransferInfo {
  return {
    transferId: '12',
    assetId: 'rgb:asset',
    amount: '7000000',
    direction: 'incoming',
    status,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    recipientId: 'utxob:abc',
    ...extra,
  };
}

describe('SqliteReceiveStore', () => {
  it('waiting → incoming → received, matched by recipient ID', () => {
    const store = new InvoiceStore(':memory:');
    let now = T0;
    const receives = new SqliteReceiveStore(store, () => now);
    const r = receives.add(
      { rgbInvoice: 'rgb:inv', recipientId: 'utxob:abc', amount: '7000000', expiresAt: '2026-10-18T10:00:00.000Z' },
      'Acme refund',
    );
    expect(r).toMatchObject({ status: 'waiting', note: 'Acme refund', amount: '7000000' });
    expect(receives.reconcile([])).toHaveLength(0);

    now = new Date(T0.getTime() + 60_000);
    expect(receives.reconcile([incoming('WaitingConfirmations')])).toMatchObject([
      { status: 'incoming', transferId: '12' },
    ]);
    expect(receives.reconcile([incoming('WaitingConfirmations')])).toHaveLength(0); // no change, no event
    expect(receives.reconcile([incoming('Settled', { txid: 'ab'.repeat(32) })])).toMatchObject([
      { status: 'received', transferId: '12', txid: 'ab'.repeat(32), receivedAmount: '7000000' },
    ]);
    // Settled requests are closed: later syncs leave them alone.
    expect(receives.reconcile([incoming('Failed')])).toHaveLength(0);
    store.close();
  });

  it('waitingRecently: an open request from the last hour keeps the wallet syncing fast', () => {
    const store = new InvoiceStore(':memory:');
    let now = T0;
    const receives = new SqliteReceiveStore(store, () => now);
    expect(receives.waitingRecently()).toBe(false);
    receives.add({ rgbInvoice: 'rgb:inv', recipientId: 'utxob:abc', expiresAt: '2026-10-18T10:00:00.000Z' });
    expect(receives.waitingRecently()).toBe(true);
    now = new Date(T0.getTime() + 61 * 60_000);
    expect(receives.waitingRecently()).toBe(false); // older than an hour: idle pace
    now = T0;
    receives.reconcile([incoming('Settled')]);
    expect(receives.waitingRecently()).toBe(false); // received: nothing to wait for
    store.close();
  });

  it('the pending transfer rgb-lib makes with the request (WaitingCounterparty) is not a payment yet', () => {
    const store = new InvoiceStore(':memory:');
    let now = T0;
    const receives = new SqliteReceiveStore(store, () => now);
    receives.add({ rgbInvoice: 'rgb:inv', recipientId: 'utxob:abc', expiresAt: '2026-10-17T11:00:00.000Z' });
    expect(receives.reconcile([incoming('WaitingCounterparty')])).toMatchObject([
      { status: 'waiting', transferId: '12' },
    ]);
    expect(receives.list()[0]?.status).toBe('waiting');
    now = new Date('2026-10-17T12:00:00.000Z'); // still unpaid after expiry
    expect(receives.reconcile([incoming('WaitingCounterparty')])).toMatchObject([{ status: 'expired' }]);
    store.close();
  });

  it('expires when nobody paid in time; outgoing transfers never match', () => {
    const store = new InvoiceStore(':memory:');
    let now = T0;
    const receives = new SqliteReceiveStore(store, () => now);
    receives.add({ rgbInvoice: 'rgb:inv', recipientId: 'utxob:abc', expiresAt: '2026-10-17T11:00:00.000Z' });
    now = new Date('2026-10-17T12:00:00.000Z');
    expect(receives.reconcile([incoming('Settled', { direction: 'outgoing' })])).toMatchObject([{ status: 'expired' }]);
    store.close();
  });
});

describe('receive routes on mocks', () => {
  let built: App;
  beforeEach(async () => {
    built = await createApp({ uploadDir: dir, dbPath: ':memory:', mockStepMs: 0 });
  });
  afterEach(async () => {
    await built.app.close();
  });

  it('POST /api/wallet/receive is remembered and listed as waiting', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/wallet/receive',
      payload: { amount: '7000000', note: 'Acme refund' },
    });
    expect(res.statusCode).toBe(200);
    const { rgbInvoice } = res.json();
    const list = (await built.app.inject({ method: 'GET', url: '/api/wallet/receives' })).json().receives;
    expect(list).toMatchObject([{ rgbInvoice, status: 'waiting', amount: '7000000', note: 'Acme refund' }]);
  });
});

describe('payment requests you can cancel, archive and page through', () => {
  const add = (receives: SqliteReceiveStore, n: number, at: Date) =>
    receives.add({
      rgbInvoice: `rgb:inv${n}`,
      recipientId: `utxob:r${n}`,
      amount: '1000000',
      expiresAt: new Date(at.getTime() + 3_600_000).toISOString(),
    });

  it('cancel: only while waiting; incoming refuses in plain words; unknown is 404', () => {
    const store = new InvoiceStore(':memory:');
    let now = T0;
    const receives = new SqliteReceiveStore(store, () => now);
    const a = add(receives, 1, now);
    const b = receives.add({ rgbInvoice: 'rgb:inv', recipientId: 'utxob:abc', expiresAt: '2026-10-18T10:00:00.000Z' });
    now = new Date(T0.getTime() + 60_000);
    expect(receives.cancel(a.receiveId)).toMatchObject({ status: 'cancelled', cancelledAt: now.toISOString() });
    expect(() => receives.cancel(a.receiveId)).toThrow(/already cancelled/);
    receives.reconcile([incoming('WaitingConfirmations')]);
    expect(() => receives.cancel(b.receiveId)).toThrow(
      'Someone is already paying this request. Wait for it to arrive.',
    );
    expect(() => receives.cancel('rcv_nope')).toThrow(/could not find/);
    store.close();
  });

  it('a payment that arrives after the cancel is shown as received (never hidden), never back to waiting', () => {
    const store = new InvoiceStore(':memory:');
    let now = T0;
    const receives = new SqliteReceiveStore(store, () => now);
    const r = receives.add({ rgbInvoice: 'rgb:inv', recipientId: 'utxob:abc', expiresAt: '2026-10-18T10:00:00.000Z' });
    receives.cancel(r.receiveId);
    expect(receives.reconcile([incoming('WaitingCounterparty')])).toHaveLength(0); // the request's own pending entry
    now = new Date('2026-10-19T10:00:00.000Z'); // past its expiry: a cancelled request does not become "expired"
    expect(receives.get(r.receiveId)?.status).toBe('cancelled');
    now = new Date(T0.getTime() + 120_000);
    expect(receives.reconcile([incoming('Settled', { txid: 'cd'.repeat(32) })])).toMatchObject([
      { status: 'received', cancelledAt: expect.any(String), receivedAmount: '7000000' },
    ]);
    store.close();
  });

  it('archive: closed or paid only; closed requests go under "Older requests" after 24 h by themselves', () => {
    const store = new InvoiceStore(':memory:');
    let now = T0;
    const receives = new SqliteReceiveStore(store, () => now);
    const open = add(receives, 1, now);
    const done = add(receives, 2, now);
    receives.cancel(done.receiveId);
    expect(() => receives.archive(open.receiveId)).toThrow(/can still be paid/);
    expect(
      receives
        .page()
        .receives.map((r) => r.receiveId)
        .sort(),
    ).toEqual([open.receiveId, done.receiveId].sort());
    expect(receives.archive(done.receiveId)).toMatchObject({ older: true, archivedAt: expect.any(String) });
    expect(receives.page().receives.map((r) => r.receiveId)).toEqual([open.receiveId]);
    expect(receives.page({ older: true }).receives.map((r) => r.receiveId)).toEqual([done.receiveId]);
    // Expired: in the main list for 24 h, then under "Older requests" without any action.
    now = new Date(T0.getTime() + 2 * 3_600_000);
    receives.reconcile([]);
    expect(receives.get(open.receiveId)).toMatchObject({ status: 'expired', older: false });
    now = new Date(T0.getTime() + 27 * 3_600_000);
    expect(receives.get(open.receiveId)?.older).toBe(true);
    expect(receives.page({ status: 'closed', older: true }).receives).toHaveLength(2);
    expect(receives.page({ status: 'open', older: true }).receives).toHaveLength(0);
    store.close();
  });

  it('45 requests from the mock wallet page 20 · 20 · 5 with nextBefore, newest first; status filter', async () => {
    const built = await createApp({ uploadDir: dir, dbPath: ':memory:', mockStepMs: 0 });
    try {
      for (let i = 0; i < 45; i++) {
        const res = await built.app.inject({ method: 'POST', url: '/api/wallet/receive', payload: { note: `n${i}` } });
        expect(res.json().receiveId).toMatch(/^rcv_/);
      }
      const seen: string[] = [];
      let before: string | undefined;
      const sizes: number[] = [];
      for (let page = 0; page < 4; page++) {
        const q = before ? `?before=${encodeURIComponent(before)}` : '';
        const body = (await built.app.inject({ method: 'GET', url: `/api/wallet/receives${q}` })).json();
        sizes.push(body.receives.length);
        seen.push(...body.receives.map((r: { receiveId: string }) => r.receiveId));
        before = body.nextBefore;
        if (!before) break;
      }
      expect(sizes).toEqual([20, 20, 5]);
      expect(new Set(seen).size).toBe(45);
      const one = (await built.app.inject({ method: 'GET', url: '/api/wallet/receives?limit=1' })).json();
      expect(one.receives[0].note).toBe('n44'); // newest first
      const id = one.receives[0].receiveId as string;
      expect((await built.app.inject({ method: 'GET', url: `/api/wallet/receives/${id}` })).json()).toMatchObject({
        receiveId: id,
        status: 'waiting',
      });
      const cancel = await built.app.inject({ method: 'POST', url: `/api/wallet/receives/${id}/cancel` });
      expect(cancel.json()).toMatchObject({ status: 'cancelled' });
      const paid = (await built.app.inject({ method: 'GET', url: '/api/wallet/receives?status=closed' })).json();
      expect(paid.receives.map((r: { receiveId: string }) => r.receiveId)).toEqual([id]);
      expect((await built.app.inject({ method: 'POST', url: `/api/wallet/receives/${id}/archive` })).statusCode).toBe(
        200,
      );
      expect((await built.app.inject({ method: 'GET', url: '/api/wallet/receives/rcv_nope' })).statusCode).toBe(404);
      const big = await built.app.inject({ method: 'GET', url: '/api/wallet/receives?limit=101' });
      expect(big.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });
});

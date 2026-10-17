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

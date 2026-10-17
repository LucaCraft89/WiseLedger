import { describe, expect, it } from 'vitest';
import { isWalletError, type WalletErrorCode } from '../src/index.js';
import {
  MemoryJobStore,
  MOCK_ASSET_ID,
  MOCK_FAIL_AMOUNT,
  MOCK_TIMEOUT_AMOUNT,
  MockWallet,
  mockInvoice,
} from '../src/mocks/index.js';

function clock(start = Date.parse('2026-10-17T10:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function code(p: Promise<unknown>): Promise<WalletErrorCode | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (isWalletError(e)) return e.code;
    throw e;
  }
}

const farFuture = Math.floor(Date.parse('2100-01-01T00:00:00Z') / 1000);

describe('MockWallet', () => {
  it('starts with 1000 TUSDT at precision 6', async () => {
    const w = new MockWallet();
    const [asset] = await w.listAssets();
    expect(asset).toMatchObject({ assetId: MOCK_ASSET_ID, ticker: 'TUSDT', precision: 6 });
    expect(asset?.balance).toEqual({ settled: '1000000000', future: '1000000000', spendable: '1000000000' });
  });

  it('pay moves WaitingCounterparty → WaitingConfirmations → Settled and updates the balance', async () => {
    const c = clock();
    const w = new MockWallet({ now: c.now, stepMs: 3000 });
    const inv = mockInvoice(undefined, undefined, farFuture);
    const { transferId, txid } = await w.pay({ rgbInvoice: inv, assetId: MOCK_ASSET_ID, amount: '25000000' });
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    expect((await w.getTransfer(transferId))?.status).toBe('WaitingCounterparty');
    expect(await w.assetBalance(MOCK_ASSET_ID)).toEqual({
      settled: '1000000000',
      future: '975000000',
      spendable: '975000000',
    });
    c.advance(3000);
    expect((await w.getTransfer(transferId))?.status).toBe('WaitingConfirmations');
    c.advance(3000);
    expect((await w.getTransfer(transferId))?.status).toBe('Settled');
    expect((await w.assetBalance(MOCK_ASSET_ID)).settled).toBe('975000000');
  });

  it('settles immediately with stepMs 0', async () => {
    const w = new MockWallet({ stepMs: 0 });
    const inv = (await w.createReceiveInvoice({ assetId: MOCK_ASSET_ID, amount: '5000000', expirySec: 3600 }))
      .rgbInvoice;
    const { transferId } = await w.pay({ rgbInvoice: inv, assetId: MOCK_ASSET_ID, amount: '5000000' });
    expect((await w.getTransfer(transferId))?.status).toBe('Settled');
  });

  it('decodes its own invoices and rejects garbage', async () => {
    const w = new MockWallet();
    const r = await w.createReceiveInvoice({ amount: '5000000', expirySec: 60 });
    const d = await w.decodeInvoice(r.rgbInvoice);
    expect(d.amount).toBe('5000000');
    expect(d.assetId).toBeUndefined();
    expect(await code(w.decodeInvoice('hello'))).toBe('InvalidInvoice');
    expect(await code(w.decodeInvoice('rgb:mock/x/1.5/10'))).toBe('InvalidInvoice');
  });

  it('refuses an expired invoice', async () => {
    const c = clock();
    const w = new MockWallet({ now: c.now });
    const { rgbInvoice } = await w.createReceiveInvoice({ expirySec: 60 });
    c.advance(61_000);
    expect(await code(w.pay({ rgbInvoice, assetId: MOCK_ASSET_ID, amount: '1' }))).toBe('InvoiceExpired');
  });

  it('refuses insufficient funds, unknown assets and mismatched invoices', async () => {
    const w = new MockWallet({ balance: '10000000' });
    const inv = mockInvoice(undefined, undefined, farFuture);
    expect(await code(w.pay({ rgbInvoice: inv, assetId: MOCK_ASSET_ID, amount: '10000001' }))).toBe(
      'InsufficientFunds',
    );
    expect(await code(w.pay({ rgbInvoice: inv, assetId: 'rgb:other', amount: '1' }))).toBe('UnknownAsset');
    expect(await code(w.assetBalance('rgb:other'))).toBe('UnknownAsset');
    const fixed = mockInvoice(MOCK_ASSET_ID, '5000000', farFuture);
    expect(await code(w.pay({ rgbInvoice: fixed, assetId: MOCK_ASSET_ID, amount: '6000000' }))).toBe('TransferFailed');
    expect(await code(w.pay({ rgbInvoice: inv, assetId: MOCK_ASSET_ID, amount: '0' }))).toBe('TransferFailed');
  });

  it('locks pending payments against double spending', async () => {
    const w = new MockWallet({ balance: '10000000', stepMs: 10_000 });
    const inv = mockInvoice(undefined, undefined, farFuture);
    expect(await code(w.pay({ rgbInvoice: inv, assetId: MOCK_ASSET_ID, amount: '6000000' }))).toBe('ok');
    expect(await code(w.pay({ rgbInvoice: inv, assetId: MOCK_ASSET_ID, amount: '6000000' }))).toBe('InsufficientFunds');
  });

  it('injects a failure by amount without moving funds', async () => {
    const w = new MockWallet({ stepMs: 0 });
    const inv = mockInvoice(undefined, undefined, farFuture);
    expect(await code(w.pay({ rgbInvoice: inv, assetId: MOCK_ASSET_ID, amount: MOCK_FAIL_AMOUNT }))).toBe(
      'TransferFailed',
    );
    expect((await w.assetBalance(MOCK_ASSET_ID)).settled).toBe('1000000000');
    expect((await w.listTransfers()).filter((t) => t.direction === 'outgoing')).toHaveLength(0);
  });

  it('simulates SubmitTimeout where the transfer still went out', async () => {
    const w = new MockWallet({ stepMs: 0 });
    const inv = mockInvoice(undefined, undefined, farFuture);
    expect(await code(w.pay({ rgbInvoice: inv, assetId: MOCK_ASSET_ID, amount: MOCK_TIMEOUT_AMOUNT }))).toBe(
      'SubmitTimeout',
    );
    await w.sync();
    const out = (await w.listTransfers(MOCK_ASSET_ID)).filter((t) => t.direction === 'outgoing');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amount: MOCK_TIMEOUT_AMOUNT, status: 'Settled', rgbInvoice: inv });
  });

  it('issues a new NIA asset', async () => {
    const w = new MockWallet();
    const a = await w.issueAssetNia({ ticker: 'EURT', name: 'Test EUR', precision: 6, amounts: ['500', '500'] });
    expect(a.balance.settled).toBe('1000');
    expect(await w.listAssets()).toHaveLength(2);
    await expect(w.issueAssetNia({ ticker: 'eurt', name: 'x', precision: 6, amounts: ['1'] })).rejects.toThrow();
  });
});

describe('MemoryJobStore', () => {
  it('lists due jobs, cancels pending ones and marks done', async () => {
    const s = new MemoryJobStore();
    const base = { planId: 'p', invoiceId: 'i', status: 'pending' as const, createdAt: 'x', updatedAt: 'x' };
    await s.put({ ...base, jobId: 'a', runAt: '2026-10-17T12:00:00Z' });
    await s.put({ ...base, jobId: 'b', runAt: '2026-10-18T12:00:00Z' });
    expect((await s.list({ dueBefore: '2026-10-17T13:00:00Z' })).map((j) => j.jobId)).toEqual(['a']);
    expect(await s.cancel('b')).toBe(true);
    expect(await s.cancel('b')).toBe(false);
    await s.markDone('a', { planId: 'p', status: 'settled', transferId: 't' });
    expect((await s.list({ status: 'done' })).map((j) => j.jobId)).toEqual(['a']);
  });
});

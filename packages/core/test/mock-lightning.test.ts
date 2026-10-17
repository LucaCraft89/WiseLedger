// The Lightning rail on the mock wallet (contract for B's B-side work): decode → rail, pay → instant Settled with a
// payment hash and no txid, lightningStatus shows the channel moving.
import { describe, expect, it } from 'vitest';
import { MOCK_ASSET_ID, MOCK_LN_INVOICE_PREFIX, MockWallet } from '../src/mocks/index.js';

const expiry = Math.floor(Date.now() / 1000) + 3600;
const ln = `${MOCK_LN_INVOICE_PREFIX}${MOCK_ASSET_ID}/2000000/${expiry}`;

describe('MockWallet Lightning rail', () => {
  it('decodes an lnrgb invoice as rail lightning with a payment hash', async () => {
    const w = new MockWallet({ stepMs: 0 });
    const d = await w.decodeInvoice(ln);
    expect(d).toMatchObject({ rail: 'lightning', amount: '2000000', assetId: MOCK_ASSET_ID });
    expect(d.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await w.decodeInvoice(`rgb:mock/${MOCK_ASSET_ID}/1/${expiry}`)).rail).toBeUndefined();
  });

  it('pays instantly: Settled, paymentHash, no txid; the channel balance moves', async () => {
    const w = new MockWallet({ stepMs: 3000 });
    const before = await w.lightningStatus();
    const r = await w.pay({ rgbInvoice: ln, assetId: MOCK_ASSET_ID, amount: '2000000' });
    expect(r.txid).toBeUndefined();
    expect(r.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await w.getTransfer(r.transferId)).toMatchObject({ status: 'Settled', rail: 'lightning' });
    const after = await w.lightningStatus();
    expect(BigInt(after.channels[0]?.localAsset ?? '0')).toBe(BigInt(before.channels[0]?.localAsset ?? '0') - 2000000n);
  });

  it('refuses more than the channel holds, in plain words; distinct invoices get distinct hashes', async () => {
    const w = new MockWallet({ stepMs: 0 });
    const big = `${MOCK_LN_INVOICE_PREFIX}${MOCK_ASSET_ID}/60000000/${expiry}`;
    await expect(w.pay({ rgbInvoice: big, assetId: MOCK_ASSET_ID, amount: '60000000' })).rejects.toThrow(
      /Lightning channel/,
    );
    const other = `${MOCK_LN_INVOICE_PREFIX}${MOCK_ASSET_ID}/2000001/${expiry}`;
    expect((await w.decodeInvoice(ln)).paymentHash).not.toBe((await w.decodeInvoice(other)).paymentHash);
  });
});

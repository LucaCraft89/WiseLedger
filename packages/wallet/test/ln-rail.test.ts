// Lightning rail over a fake RGB Lightning node: rail-aware decode, pay over the channel (or a plain refusal), both
// rails in the transfer list, on-chain calls unchanged.
import { InsufficientFunds, type WalletPort } from 'core';
import { MOCK_ASSET_ID, MockWallet } from 'core/mocks';
import { describe, expect, it } from 'vitest';
import type { LnNode } from '../src/ln/node.js';
import { looksLightning, withLightning } from '../src/ln/rail.js';

const HASH = 'ab'.repeat(32);
const LN = `lntbs20u1${'q'.repeat(60)}`;

function fakeNode(local = 10_000_000) {
  const payments: { payment_hash: string; status: string; inbound: boolean; asset_amount: number; asset_id: string }[] =
    [];
  const calls: string[] = [];
  const node = {
    pubkey: `02${'c'.repeat(64)}`,
    async call(method: string) {
      calls.push(method);
      if (method === 'decodeInvoice')
        return {
          payment_hash: HASH,
          asset_id: MOCK_ASSET_ID,
          asset_amount: 2_000_000,
          timestamp: Math.floor(Date.now() / 1000),
          expiry_sec: 3600,
        };
      if (method === 'sendPayment') {
        payments.push({
          payment_hash: HASH,
          status: 'Succeeded',
          inbound: false,
          asset_amount: 2_000_000,
          asset_id: MOCK_ASSET_ID,
        });
        return { payment_hash: HASH, status: 'Pending' };
      }
      return undefined;
    },
    async channels() {
      return [
        {
          channel_id: 'chan1',
          peer_pubkey: `03${'a'.repeat(64)}`,
          ready: true,
          is_usable: true,
          capacity_sat: 30_010,
          asset_id: MOCK_ASSET_ID,
          asset_local_amount: local,
          asset_remote_amount: 0,
        },
      ];
    },
    async payments() {
      return payments;
    },
  } as unknown as LnNode;
  return { node, calls };
}

describe('Lightning rail', () => {
  it('recognises signet/regtest BOLT11, not on-chain RGB invoices', () => {
    expect(looksLightning(LN)).toBe(true);
    expect(looksLightning(`lightning:${LN}`)).toBe(true);
    expect(looksLightning('rgb:~/~/abc/sb:utxob:xyz')).toBe(false);
  });

  it('decodes a Lightning invoice as rail lightning; on-chain invoices go to the on-chain wallet', async () => {
    const w = withLightning(new MockWallet({ stepMs: 0 }) as WalletPort, fakeNode().node);
    expect(await w.decodeInvoice(LN)).toMatchObject({
      rail: 'lightning',
      paymentHash: HASH,
      amount: '2000000',
      assetId: MOCK_ASSET_ID,
    });
    const onchain = `rgb:mock/${MOCK_ASSET_ID}/1000000/${Math.floor(Date.now() / 1000) + 600}`;
    expect((await w.decodeInvoice(onchain)).rail).toBeUndefined();
  });

  it('pays over the channel: payment hash, no txid, Settled in the transfer list', async () => {
    const { node, calls } = fakeNode();
    const w = withLightning(new MockWallet({ stepMs: 0 }) as WalletPort, node, { followMs: 3000 });
    const r = await w.pay({ rgbInvoice: LN, assetId: MOCK_ASSET_ID, amount: '2000000' });
    expect(r).toEqual({ transferId: `ln:${HASH}`, paymentHash: HASH });
    expect(calls).toContain('sendPayment');
    expect(await w.getTransfer(r.transferId)).toMatchObject({
      status: 'Settled',
      rail: 'lightning',
      direction: 'outgoing',
    });
    expect((await w.listTransfers()).some((t) => t.transferId === r.transferId)).toBe(true);
  });

  it('refuses in plain words when the channel cannot carry it (nothing sent)', async () => {
    const { node, calls } = fakeNode(1_000_000);
    const w = withLightning(new MockWallet({ stepMs: 0 }) as WalletPort, node);
    await expect(w.pay({ rgbInvoice: LN, assetId: MOCK_ASSET_ID, amount: '2000000' })).rejects.toBeInstanceOf(
      InsufficientFunds,
    );
    expect(calls).not.toContain('sendPayment');
  });

  it('lightningStatus lists the channel; no problem when usable', async () => {
    const w = withLightning(new MockWallet({ stepMs: 0 }) as WalletPort, fakeNode().node);
    const s = await w.lightningStatus?.();
    expect(s).toMatchObject({
      enabled: true,
      channels: [{ channelId: 'chan1', usable: true, localAsset: '10000000' }],
    });
    expect(s?.problem).toBeUndefined();
  });
});

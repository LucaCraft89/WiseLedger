import { describe, expect, it } from 'vitest';
import type { AppEvent, LightningStatusResponse } from './api/contracts.js';
import { createFakeClient } from './api/fake.js';
import { LN_PROGRESS_LABELS, paidSentence, paymentProgress } from './lib/confirm.js';
import { lightningTotals } from './WalletPage.js';

const at = '2026-10-17T10:00:00.000Z';
const LN = 'lntbs250u1pjrgbtusdtmockinvoice0hash';

describe('Lightning payments in the UI', () => {
  it('three-step progress, payment hash instead of a txid', () => {
    const statuses = (p: ReturnType<typeof paymentProgress>) => p.steps.map((s) => s.status);
    const executing: AppEvent[] = [{ type: 'state', at, from: 'CONFIRMED', to: 'EXECUTING' }];
    const p0 = paymentProgress('EXECUTING', executing, undefined, true);
    expect(p0.steps.map((s) => s.label)).toEqual([...LN_PROGRESS_LABELS]);
    expect(statuses(p0)).toEqual(['running', 'pending', 'pending']);
    const sending = [
      ...executing,
      { type: 'transfer', at, transferId: 't1', status: 'WaitingCounterparty' } as AppEvent,
    ];
    expect(statuses(paymentProgress('EXECUTING', sending, undefined, true))).toEqual(['done', 'running', 'pending']);
    const settled = [
      ...sending,
      { type: 'transfer', at, transferId: 't1', status: 'Settled', paymentHash: 'ab'.repeat(32) } as AppEvent,
    ];
    const p = paymentProgress('EXECUTING', settled, undefined, true);
    expect(statuses(p)).toEqual(['done', 'done', 'done']);
    expect(p.paymentHash).toBe('ab'.repeat(32));
    expect(p.txid).toBeUndefined();
    // On-chain stays four steps.
    expect(paymentProgress('PAID', settled).steps).toHaveLength(4);
  });

  it('the paid sentence says "over Lightning"', () => {
    const plan = {
      amount: '25000000',
      assetId: 'rgb:mock-tusdt',
      payee: { name: 'Acme Srl' },
      executeAt: 'now' as const,
    };
    const assets = [{ assetId: 'rgb:mock-tusdt', ticker: 'TUSDT', precision: 6 }];
    expect(paidSentence({ ...plan, rgbInvoice: LN }, assets)).toBe(
      '25.00 TUSDT (asset rgb:mock-tusdt) to Acme Srl over Lightning',
    );
    expect(paidSentence(plan, assets)).toBe('25.00 TUSDT (asset rgb:mock-tusdt) to Acme Srl');
  });

  it('wallet panel sums usable channels per asset', () => {
    const ln: LightningStatusResponse = {
      enabled: true,
      channels: [
        { channelId: 'c1', peer: 'p', assetId: 'rgb:a', localAsset: '30000000', remoteAsset: '0', usable: true },
        { channelId: 'c2', peer: 'p', assetId: 'rgb:a', localAsset: '20000000', remoteAsset: '5', usable: true },
        { channelId: 'c3', peer: 'p', assetId: 'rgb:a', localAsset: '99', remoteAsset: '99', usable: false },
      ],
    };
    expect(lightningTotals(ln)).toEqual([{ assetId: 'rgb:a', send: 50000000n, receive: 5n }]);
  });

  it('the fake backend reports only what the mock wallet knows', async () => {
    const api = createFakeClient();
    const ln = await api.lightning();
    expect(ln.channels.every((c) => typeof c.usable === 'boolean')).toBe(true);
  });
});

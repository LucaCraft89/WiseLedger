import { describe, expect, it } from 'vitest';
import type { TransferDetailResponse } from './api/contracts.js';
import { sortCheckLines } from './lib/payment.js';
import { settlementView } from './lib/settlement.js';

const detail = (patch: Partial<TransferDetailResponse['transfer']> = {}, times = {}): TransferDetailResponse => ({
  transfer: {
    transferId: '17',
    assetId: 'rgb:UR2X9KDC',
    amount: '25000000',
    direction: 'out',
    status: 'Settled',
    labels: [],
    createdAt: '2026-10-17T14:46:30.000Z',
    updatedAt: '2026-10-17T14:47:11.000Z',
    txid: 'ab'.repeat(32),
    kind: 'outgoing',
    rail: 'onchain',
    sealType: 'blinded',
    transportEndpoints: ['https://proxy.kaleidoswap.com/json-rpc'],
    settledAt: '2026-10-17T14:47:11.000Z',
    ...patch,
  },
  asset: { assetId: 'rgb:UR2X9KDC', ticker: 'TUSDT', name: 'Test USDT', precision: 6, schema: 'NIA' },
  statusTimes: { WaitingCounterparty: '2026-10-17T14:46:30.000Z', Settled: '2026-10-17T14:47:11.000Z', ...times },
});

describe('How this was settled', () => {
  it('settled send: headline, three done steps, validation, privacy line, technical terms explained', () => {
    const v = settlementView(detail());
    expect(v.headline).toBe('Paid with TUSDT — identified by its contract, not its name');
    expect(v.ladder.map((s) => [s.label, s.state])).toEqual([
      ["Waiting for the supplier's wallet", 'done'],
      ['Waiting for Bitcoin to confirm (about a minute)', 'done'],
      ['Settled', 'done'],
    ]);
    expect(v.validated).toMatch(/supplier's wallet checked the full history/);
    expect(v.privacy).toMatch(/ordinary transaction/);
    const labels = v.tech.map((t) => t.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Asset ID', 'Schema', 'Transfer ID', 'Bitcoin txid', 'Seal type', 'Transport endpoint']),
    );
    expect(v.tech.find((t) => t.label === 'Seal type')?.explain).toMatch(/hidden even from you/);
    expect(v.tech.find((t) => t.label === 'Asset ID')?.explain).toMatch(
      /fake token with the same name would be refused/,
    );
  });

  it('waiting for the supplier: no validation line yet, first step current', () => {
    const v = settlementView(detail({ status: 'WaitingCounterparty', settledAt: undefined }, { Settled: undefined }));
    expect(v.validated).toBeUndefined();
    expect(v.ladder.map((s) => s.state)).toEqual(['current', 'pending', 'pending']);
  });

  it('incoming mirrors the wording; failed says what to do next', () => {
    const inc = settlementView(detail({ kind: 'incoming', direction: 'in', status: 'WaitingConfirmations' }));
    expect(inc.headline).toMatch(/^Received TUSDT/);
    expect(inc.validated).toBe('You checked the full history of these tokens before accepting them.');
    const failed = settlementView(detail({ status: 'Failed' }, { Settled: undefined, Failed: '2026-10-17T15:00:00Z' }));
    expect(failed.ladder.at(-1)).toMatchObject({ state: 'failed' });
    expect(failed.failedNext).toMatch(/Nothing was sent/);
  });

  it('Lightning: rail, payment hash and channel instead of txid and seal', () => {
    const v = settlementView({
      ...detail({ rail: 'lightning', txid: undefined, sealType: undefined, paymentHash: 'cd'.repeat(32) }),
      lightning: { paymentHash: 'cd'.repeat(32), channelId: 'ch1' },
    });
    expect(v.headline).toMatch(/over Lightning/);
    expect(v.privacy).toBeUndefined();
    expect(v.tech.map((t) => t.label)).toEqual(expect.arrayContaining(['Rail', 'Payment hash', 'Channel']));
    expect(v.tech.map((t) => t.label)).not.toContain('Seal type');
  });

  it('payment request check lines: failures first', () => {
    const lines = [
      { check: 'decodes', result: 'ok' },
      { check: 'transport_known', result: 'review' },
      { check: 'amount_matches', result: 'block' },
    ] as const;
    expect(sortCheckLines(lines).map((l) => l.check)).toEqual(['amount_matches', 'transport_known', 'decodes']);
  });
});

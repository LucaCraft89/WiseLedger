import { describe, expect, it } from 'vitest';
import type { InvoiceSummaryDto, ReceiveRequestDto, TransferDto, WalletResponse } from './api/contracts.js';
import { balanceSentence, composeDesk, DESK_MAX, greeting, payees } from './lib/desk.js';
import { NAV, redirectFor, sectionOf } from './lib/routes.js';

const NOW = new Date('2026-10-18T10:00:00');
const inv = (o: Partial<InvoiceSummaryDto> & { id: string }): InvoiceSummaryDto => ({
  filename: `${o.id}.pdf`,
  kind: 'pdf',
  state: 'AWAITING_CONFIRMATION',
  createdAt: '2026-10-18T08:00:00Z',
  updatedAt: '2026-10-18T08:00:00Z',
  ...o,
});
const wallet = (btc: string): WalletResponse => ({
  backend: 'mock',
  network: 'mock',
  ready: true,
  btcBalanceSats: btc,
  assets: [
    {
      assetId: 'rgb:a',
      ticker: 'TUSDT',
      name: 'T',
      precision: 6,
      balance: { settled: '975000000', future: '975000000', spendable: '975000000' },
    },
  ],
});
const base = { invoices: [], jobs: [], receives: [], transfers: [], wallet: wallet('1000000'), problems: [] };

describe('desk: needs you', () => {
  it('orders by urgency (problems, confirm, review, expiring, low fees) and caps at 5', () => {
    const receive = {
      receiveId: 'r1',
      rgbInvoice: 'rgb:x',
      recipientId: 'x',
      status: 'waiting',
      createdAt: '',
      updatedAt: '',
      expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    } as ReceiveRequestDto;
    const d = composeDesk(
      {
        ...base,
        wallet: wallet('100'),
        problems: ['No internet right now.'],
        receives: [receive],
        invoices: [
          inv({ id: 'a', issuerName: 'Review Ltd', verdict: 'review' }),
          inv({ id: 'b', issuerName: 'Acme', verdict: 'ok' }),
        ],
      },
      NOW,
    );
    expect(d.needsYou.map((n) => n.kind)).toEqual(['problem', 'confirm', 'review', 'request_expiring', 'low_fees']);
    expect(d.needsYou[3]?.title).toBe('A payment request ends in 30 minutes.');
    const many = composeDesk({ ...base, problems: ['1', '2', '3', '4', '5', '6', '7'] }, NOW);
    expect(many.needsYou).toHaveLength(DESK_MAX);
  });

  it('is empty, with plain greeting, when nothing needs the user', () => {
    const d = composeDesk(base, NOW);
    expect(d.needsYou).toEqual([]);
    expect(d.lately).toEqual([]);
    expect(greeting(0, NOW)).toBe('Good morning. Nothing needs you right now.');
    expect(greeting(2, NOW)).toBe('Good morning. 2 things need you.');
    expect(greeting(1, NOW)).toBe('Good morning. 1 thing needs you.');
  });

  it('does not nag about blocked, paid or already-decided invoices, or far-off requests', () => {
    const far = {
      receiveId: 'r',
      status: 'waiting',
      expiresAt: new Date(NOW.getTime() + 48 * 3_600_000).toISOString(),
    } as ReceiveRequestDto;
    const d = composeDesk(
      {
        ...base,
        receives: [far],
        invoices: [inv({ id: 'p', state: 'PAID' }), inv({ id: 'x', state: 'BLOCKED', verdict: 'block' })],
      },
      NOW,
    );
    expect(d.needsYou).toEqual([]);
  });
});

describe('desk: lately', () => {
  it('lists paid, received and blocked, newest first, from real transfers and invoices', () => {
    const t = (o: Partial<TransferDto> & { transferId: string }): TransferDto => ({
      assetId: 'rgb:a',
      amount: '25000000',
      direction: 'out',
      status: 'Settled',
      labels: [],
      createdAt: '2026-10-18T09:00:00Z',
      ...o,
    });
    const d = composeDesk(
      {
        ...base,
        invoices: [
          inv({ id: 'i1', issuerName: 'Acme', state: 'PAID' }),
          inv({ id: 'i2', issuerName: 'Nordic Ltd', state: 'BLOCKED', updatedAt: '2026-10-18T09:30:00Z' }),
        ],
        receives: [{ receiveId: 'r2', status: 'received', transferId: 't2', expiresAt: '' } as ReceiveRequestDto],
        transfers: [
          t({ transferId: 't1', invoiceId: 'i1' }),
          t({ transferId: 'issue', direction: 'in', createdAt: '2026-10-17T07:00:00Z' }),
          t({ transferId: 't2', direction: 'in', amount: '5000000', createdAt: '2026-10-18T07:00:00Z' }),
          t({ transferId: 't3', status: 'WaitingConfirmations' }),
        ],
      },
      NOW,
    );
    expect(d.lately.map((l) => l.text)).toEqual([
      'I stopped an invoice from Nordic Ltd.',
      'Paid. Acme has their 25.00 TUSDT.',
      'Received 5.00 TUSDT.',
    ]);
    expect(d.lately[1]?.href).toBe('#/invoice/i1');
  });

  it('says the balance in plain words', () => {
    expect(balanceSentence(composeDesk(base, NOW))).toBe('975.00 TUSDT ready to spend · 0.01 test BTC for fees');
  });
});

describe('books: people you pay', () => {
  it('groups paid invoices by supplier with count and last amount', () => {
    const list = payees([
      inv({
        id: '1',
        issuerName: 'Acme',
        state: 'PAID',
        total: '10.00',
        currency: 'TUSDT',
        updatedAt: '2026-10-01T00:00:00Z',
      }),
      inv({
        id: '2',
        issuerName: 'Acme',
        state: 'PAID',
        total: '25.00',
        currency: 'TUSDT',
        updatedAt: '2026-10-10T00:00:00Z',
      }),
      inv({ id: '3', issuerName: 'Nordic', state: 'BLOCKED' }),
    ]);
    expect(list).toEqual([
      { name: 'Acme', times: 2, lastTotal: '25.00', lastCurrency: 'TUSDT', lastAt: '2026-10-10T00:00:00Z' },
    ]);
  });
});

describe('navigation', () => {
  it('has six sections in the fixed order', () => {
    expect(NAV.map((n) => n.label)).toEqual(['Desk', 'Pay', 'Get paid', 'Books', 'Ask Wise', 'Settings']);
  });
  it('old hashes redirect, current ones do not', () => {
    expect(redirectFor('#/wallet')).toBe('#/settings/money');
    expect(redirectFor('#/wallet/details')).toBe('#/settings/money');
    expect(redirectFor('#/wallet/get-paid')).toBe('#/get-paid');
    expect(redirectFor('#/wallet/get-paid?like=r1')).toBe('#/get-paid?like=r1');
    expect(redirectFor('#/chat')).toBe('#/ask');
    expect(redirectFor('#/invoices')).toBe('#/pay/invoices');
    expect(redirectFor('#/schedule')).toBe('#/pay/scheduled');
    expect(redirectFor('#/transfers')).toBe('#/books');
    for (const h of ['', '#/', '#/pay', '#/get-paid/r1', '#/books', '#/ask', '#/settings', '#/invoice/x'])
      expect(redirectFor(h)).toBeNull();
  });
  it('maps every page to one nav entry', () => {
    expect(sectionOf('#/invoice/x')).toBe('#/pay');
    expect(sectionOf('#/pay/scheduled')).toBe('#/pay');
    expect(sectionOf('#/settings/money')).toBe('#/settings');
    expect(sectionOf('')).toBe('#/');
  });
});

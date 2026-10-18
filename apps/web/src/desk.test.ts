import { describe, expect, it } from 'vitest';
import { balanceSentence, greeting, latelyHref, payees } from './lib/desk.js';
import { NAV, redirectFor, sectionOf } from './lib/routes.js';

const inv = (o: Record<string, unknown>) =>
  ({ filename: 'f.pdf', kind: 'pdf', createdAt: '', updatedAt: '2026-10-01T00:00:00Z', ...o }) as never;

describe('desk words', () => {
  it('greets by count and says the balance in plain words', () => {
    const at = new Date('2026-10-18T10:00:00');
    expect(greeting(0, at)).toBe('Good morning. Nothing needs you right now.');
    expect(greeting(1, at)).toBe('Good morning. 1 thing needs you.');
    expect(greeting(2, at)).toBe('Good morning. 2 things need you.');
    const balances = [{ assetId: 'a', ticker: 'TUSDT', precision: 6, spendable: '975000000' }];
    expect(balanceSentence({ balances, feeSats: '1000000' })).toBe(
      '975.00 TUSDT ready to spend · 1,000,000 sats for fees',
    );
  });
  it('links each Lately line to its invoice, request or the books', () => {
    expect(latelyHref({ kind: 'paid', id: 'inv1' })).toBe('#/invoice/inv1');
    expect(latelyHref({ kind: 'received', id: 'rcv1' })).toBe('#/get-paid/rcv1');
    expect(latelyHref({ kind: 'received', id: 'transfer-9' })).toBe('#/books');
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
    expect(NAV.map((n) => n.label)).toEqual(['Desk', 'Pay', 'Get paid', 'Books', 'Ask Wise', 'Me', 'Settings']);
  });
  it('old hashes redirect, current ones do not', () => {
    expect(redirectFor('#/wallet')).toBe('#/me');
    expect(redirectFor('#/settings/money')).toBe('#/me');
    expect(redirectFor('#/wallet/details')).toBe('#/me');
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
    expect(sectionOf('#/me')).toBe('#/me');
    expect(sectionOf('')).toBe('#/');
  });
});

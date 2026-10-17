import { describe, expect, it } from 'vitest';
import { toBtcTransactions } from '../src/routes.js';

describe('toBtcTransactions', () => {
  it('maps received, sent, internal; unconfirmed first; drops malformed rows', () => {
    const out = toBtcTransactions([
      { transactionType: 3, txid: 'a', received: 150000, sent: 0, fee: 0, confirmationTime: { timestamp: 1000 } },
      { transactionType: 3, txid: 'b', received: 40000, sent: 100000, fee: 300, confirmationTime: { timestamp: 2000 } },
      { transactionType: 0, txid: 'c', received: 999700, sent: 1000000, fee: 300 },
      { transactionType: 2, txid: 'bad', received: -1, sent: 0, fee: 0 },
      { transactionType: 9, txid: 'd', received: 5, sent: 0, fee: 0, confirmationTime: { timestamp: 500 } },
    ]);
    expect(out.map((t) => t.txid)).toEqual(['c', 'b', 'a', 'd']);
    expect(out[0]).toMatchObject({
      direction: 'internal',
      purpose: 'token_payment',
      amountSats: '0',
      feeSats: '300',
      confirmed: false,
    });
    expect(out[1]).toMatchObject({ direction: 'sent', amountSats: '59700', feeSats: '300', confirmed: true });
    expect(out[2]).toMatchObject({ direction: 'received', amountSats: '150000', feeSats: '0' });
    expect(out[3]?.purpose).toBe('bitcoin');
  });
  it('returns [] for a backend without the list', () => {
    expect(toBtcTransactions(undefined)).toEqual([]);
  });
});

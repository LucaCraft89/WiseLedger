// Books as a ledger: Date | What | In | Out | Balance. The server builds the rows (GET /api/books, running settled
// balance, newest row = the wallet's balance); this turns them into the words on screen.
import type { BooksResponse } from '../api/contracts.js';
import { groupDigits } from './desk.js';
import { formatAmount } from './format.js';

export interface BookRow {
  key: string;
  transferId?: string;
  at: string;
  what: string;
  invoiceId?: string;
  /** Amount with ticker, filled in only on the matching side. */
  in?: string;
  out?: string;
  /** Balance after this row; absent while pending or for a failed transfer. */
  balance?: string;
  pending: boolean;
  failed: boolean;
  /** A receipt exists only for settled payments in or out. */
  canReceipt: boolean;
  labels: string[];
}

export function bookRows(res: Pick<BooksResponse, 'rows' | 'ticker' | 'precision'>): BookRow[] {
  const money = (amount: string) =>
    `${groupDigits(formatAmount(amount, res.precision ?? 0))} ${res.ticker ?? ''}`.trim();
  return res.rows.map((r, i): BookRow => {
    const failed = r.stamp === 'FAILED';
    return {
      key: r.transferId ?? `${r.at}-${i}`,
      ...(r.transferId ? { transferId: r.transferId } : {}),
      at: r.at,
      what: r.title,
      ...(r.invoiceId ? { invoiceId: r.invoiceId } : {}),
      ...(r.in ? { in: money(r.in) } : {}),
      ...(r.out ? { out: money(r.out) } : {}),
      ...(r.balanceAfter != null ? { balance: money(r.balanceAfter) } : {}),
      pending: r.pending === true,
      failed,
      canReceipt: Boolean(r.transferId) && (r.stamp === 'PAID' || r.stamp === 'RECEIVED'),
      labels: r.labels,
    };
  });
}

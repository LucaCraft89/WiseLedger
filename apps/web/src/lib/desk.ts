// Money Desk helpers. The desk itself is built by the server (GET /api/desk); the demo backend has a small stand-in
// (api/desk.ts). These turn its answer into the words on screen.
import type { DeskLatelyItem, DeskResponse, InvoiceSummaryDto } from '../api/contracts.js';
import { formatAmount } from './format.js';

export function greeting(needsCount: number, now: Date = new Date()): string {
  const h = now.getHours();
  const hello = h < 5 ? 'Hello.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
  if (needsCount === 0) return `${hello} Nothing needs you right now.`;
  return `${hello} ${needsCount === 1 ? '1 thing needs' : `${needsCount} things need`} you.`;
}

/** "975.00 TUSDT ready to spend · 0.01 test BTC for fees". */
export function balanceSentence(d: Pick<DeskResponse, 'balances' | 'feeSats'>): string {
  const tokens = d.balances.map((b) => `${formatAmount(b.spendable, b.precision)} ${b.ticker}`).join(' + ');
  const parts: string[] = [];
  if (tokens) parts.push(`${tokens} ready to spend`);
  if (d.feeSats !== undefined && /^\d+$/.test(d.feeSats)) {
    const sats = BigInt(d.feeSats);
    parts.push(
      `${(sats / 100_000_000n).toString()}.${(sats % 100_000_000n).toString().padStart(8, '0').slice(0, 2)} test BTC for fees`,
    );
  }
  return parts.join(' · ') || 'No tokens in your wallet yet.';
}

/** Where a "Lately" line opens: its invoice, its payment request, or the books for a bare transfer. */
export function latelyHref(l: Pick<DeskLatelyItem, 'kind' | 'id'>): string {
  if (l.id.startsWith('transfer-')) return '#/books';
  if (l.kind === 'received') return `#/get-paid/${encodeURIComponent(l.id)}`;
  return `#/invoice/${encodeURIComponent(l.id)}`;
}

export interface Payee {
  name: string;
  times: number;
  lastTotal?: string;
  lastCurrency?: string;
  lastAt: string;
}

/** "People you pay": paid invoices grouped by supplier, most recent first. */
export function payees(invoices: readonly InvoiceSummaryDto[]): Payee[] {
  const byName = new Map<string, Payee>();
  for (const i of [...invoices].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))) {
    if (i.state !== 'PAID' || !i.issuerName) continue;
    const prev = byName.get(i.issuerName);
    byName.set(i.issuerName, {
      name: i.issuerName,
      times: (prev?.times ?? 0) + 1,
      lastTotal: i.total,
      lastCurrency: i.currency,
      lastAt: i.updatedAt,
    });
  }
  return [...byName.values()].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
}

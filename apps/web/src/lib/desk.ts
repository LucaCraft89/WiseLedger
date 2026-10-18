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

/** "975.00 TUSDT ready to spend · 12,400 sats for fees". */
export function balanceSentence(d: Pick<DeskResponse, 'balances' | 'feeSats'>): string {
  const tokens = d.balances.map((b) => `${formatAmount(b.spendable, b.precision)} ${b.ticker}`).join(' + ');
  const parts: string[] = [];
  if (tokens) parts.push(`${tokens} ready to spend`);
  if (d.feeSats !== undefined && /^\d+$/.test(d.feeSats)) parts.push(`${groupDigits(d.feeSats)} sats for fees`);
  return parts.join(' · ') || 'No tokens yet.';
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

export type DeskMood = NonNullable<DeskResponse['mood']>;

/** The Desk chip: icon + word, always from the server's `mood` (code falls back to the open-items count). */
export const DESK_MOODS: Record<DeskMood, { icon: string; word: string }> = {
  busy: { icon: '💭', word: 'Thinking…' },
  attention: { icon: '❗', word: 'Something needs you' },
  quiet: { icon: '✅', word: 'All quiet' },
};

export function deskMood(d: Pick<DeskResponse, 'mood' | 'greetingCounts'>): DeskMood {
  return d.mood ?? (d.greetingCounts.needsYou > 0 ? 'attention' : 'quiet');
}

/** Missing fee money comes first, then the server's order (already most urgent first). */
export function orderNeeds<T extends { kind: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Number(b.kind === 'low_fee_balance') - Number(a.kind === 'low_fee_balance'));
}

/** 1240.5 → "1,240.5" on the whole part only. */
export function groupDigits(amount: string): string {
  const [whole = '', frac] = amount.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac !== undefined ? `.${frac}` : ''}`;
}

/** "This month I read 14 invoices, stopped 3 and protected 1,240.00 TUSDT." Null when every counter is 0. */
export function monthLine(m: DeskResponse['month'], balances: DeskResponse['balances'] = []): string | null {
  if (!m) return null;
  const protectedText = m.protectedAmount
    .filter((p) => BigInt(p.amount) > 0n)
    .flatMap((p) => {
      const b = balances.find((x) => x.assetId === p.assetId);
      return b ? [`${groupDigits(formatAmount(p.amount, b.precision))} ${b.ticker}`] : [];
    })
    .join(' + ');
  if (m.invoicesRead === 0 && m.invoicesStopped === 0 && !protectedText) return null;
  const parts = [
    `read ${m.invoicesRead} ${m.invoicesRead === 1 ? 'invoice' : 'invoices'}`,
    `stopped ${m.invoicesStopped}`,
  ];
  if (protectedText) parts.push(`protected ${protectedText}`);
  const last = parts.pop();
  return `This month I ${parts.join(', ')} and ${last}.`;
}

/** Ledger date line under the greeting; `stale` (older than 5 min) is shown in review tone. */
export function dateLine(
  now: Date,
  updated: DeskResponse['updated'],
  syncedAt?: string,
): { text: string; stale: boolean } {
  const at = syncedAt ?? updated.at;
  const day = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const secs =
    updated.secondsAgo ?? (at ? Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 1000)) : undefined);
  if (secs === undefined) return { text: day, stale: false };
  const stale = secs > 300;
  const ago = secs < 90 ? `${secs} s ago` : `${Math.round(secs / 60)} min ago`;
  return {
    text: stale ? `${day} · last checked ${ago}` : `${day} · your books are up to date (checked ${ago})`,
    stale,
  };
}

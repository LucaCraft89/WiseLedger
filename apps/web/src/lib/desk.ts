// The Money Desk: what needs the user today and what happened lately, from real data only.
// `composeDesk` is the same shape GET /api/desk returns; until the server has that route the web app builds it
// from the routes that exist (invoices, schedule, payment requests, transfers, wallet, health).
import type {
  DeskLately,
  DeskNeed,
  DeskResponse,
  InvoiceSummaryDto,
  Job,
  ReceiveRequestDto,
  TransferDto,
  WalletResponse,
} from '../api/contracts.js';
import { formatAmount } from './format.js';
import { recentTransfers } from './ledger.js';

export const DESK_MAX = 5;
/** Below this many sats the wallet may not afford the network fee of the next payment. */
export const LOW_FEE_SATS = 2000n;
/** A waiting payment request closer than this to its end is "about to expire". */
export const EXPIRING_MS = 6 * 3_600_000;

export interface DeskInput {
  invoices: readonly InvoiceSummaryDto[];
  jobs: readonly Job[];
  /** Every payment request, any status (the paid ones say what was received). */
  receives: readonly ReceiveRequestDto[];
  transfers: readonly TransferDto[];
  wallet: WalletResponse;
  /** HealthResponse.problems */
  problems: readonly string[];
}

/** Most urgent first. */
const URGENCY: Record<DeskNeed['kind'], number> = {
  problem: 0,
  confirm: 1,
  review: 2,
  due_soon: 3,
  scheduled_today: 4,
  request_expiring: 5,
  low_fees: 6,
};

const who = (i: Pick<InvoiceSummaryDto, 'issuerName' | 'filename'> | undefined) =>
  i?.issuerName ?? i?.filename ?? 'a supplier';
const invoiceHref = (id: string) => `#/invoice/${encodeURIComponent(id)}`;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function composeDesk(input: DeskInput, now: Date = new Date()): DeskResponse {
  const byId = new Map(input.invoices.map((i) => [i.id, i]));
  const needs: DeskNeed[] = [];

  for (const p of input.problems)
    needs.push({ kind: 'problem', title: p, href: '#/settings', action: 'Open settings' });

  for (const i of input.invoices) {
    if (i.state !== 'AWAITING_CONFIRMATION' && i.state !== 'ANALYZED') continue;
    if (i.verdict === 'review')
      needs.push({
        kind: 'review',
        title: `Check before paying: ${who(i)}.`,
        detail: 'I found something unusual. Read it, then decide.',
        href: invoiceHref(i.id),
        action: 'Read my report',
        at: i.updatedAt,
      });
    else if (i.verdict === 'ok')
      needs.push({
        kind: 'confirm',
        title: `${who(i)} is waiting for your yes.`,
        href: invoiceHref(i.id),
        action: 'Review and pay',
        at: i.updatedAt,
      });
  }

  for (const j of input.jobs) {
    if (j.status !== 'pending' || !sameDay(new Date(j.runAt), now)) continue;
    needs.push({
      kind: 'scheduled_today',
      title: `A payment to ${who(byId.get(j.invoiceId))} is set for today.`,
      href: '#/pay/scheduled',
      action: 'See scheduled',
      at: j.runAt,
    });
  }

  for (const r of input.receives) {
    const left = Date.parse(r.expiresAt) - now.getTime();
    if (r.status === 'waiting' && left > 0 && left <= EXPIRING_MS)
      needs.push({
        kind: 'request_expiring',
        title: `A payment request ends in ${left < 3_600_000 ? `${Math.max(1, Math.round(left / 60_000))} minutes` : `${Math.round(left / 3_600_000)} hours`}.`,
        href: `#/get-paid/${encodeURIComponent(r.receiveId)}`,
        action: 'Open it',
        at: r.expiresAt,
      });
  }

  if (
    input.wallet.btcBalanceSats !== undefined &&
    /^\d+$/.test(input.wallet.btcBalanceSats) &&
    BigInt(input.wallet.btcBalanceSats) < LOW_FEE_SATS
  )
    needs.push({
      kind: 'low_fees',
      title: 'Your Bitcoin for fees is running low.',
      detail: 'Every payment needs a little Bitcoin for the network fee.',
      href: '#/settings/money',
      action: 'Add some',
    });

  needsSorted(needs);

  const assets = input.wallet.assets;
  const lately: DeskLately[] = [];
  // Incoming money is "received" only when it paid one of my payment requests (not the test asset issuance).
  const paidRequests = new Set(input.receives.flatMap((r) => (r.transferId ? [r.transferId] : [])));
  for (const t of recentTransfers(input.transfers, 20)) {
    if (t.status !== 'Settled') continue;
    if (t.direction === 'in' && !paidRequests.has(t.transferId)) continue;
    const a = assets.find((x) => x.assetId === t.assetId);
    const amount = a ? `${formatAmount(t.amount, a.precision)} ${a.ticker}` : `${t.amount} base units`;
    const inv = t.invoiceId ? byId.get(t.invoiceId) : undefined;
    lately.push(
      t.direction === 'out'
        ? {
            kind: 'paid',
            text: `Paid. ${who(inv)} has their ${amount}.`,
            href: t.invoiceId ? invoiceHref(t.invoiceId) : '#/books',
            at: t.updatedAt ?? t.createdAt,
          }
        : { kind: 'received', text: `Received ${amount}.`, href: '#/books', at: t.updatedAt ?? t.createdAt },
    );
  }
  for (const i of input.invoices)
    if (i.state === 'BLOCKED')
      lately.push({
        kind: 'blocked',
        text: `I stopped an invoice from ${who(i)}.`,
        href: invoiceHref(i.id),
        at: i.updatedAt,
      });
  lately.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    balances: assets.map((a) => ({
      assetId: a.assetId,
      ticker: a.ticker,
      precision: a.precision,
      spendable: a.balance.spendable,
    })),
    btcSats: input.wallet.btcBalanceSats,
    needsYou: needs.slice(0, DESK_MAX),
    lately: lately.slice(0, DESK_MAX),
  };
}

/** Urgency first; inside a kind the newest first. Sorts in place. */
function needsSorted(needs: DeskNeed[]): void {
  needs.sort((a, b) => URGENCY[a.kind] - URGENCY[b.kind] || Date.parse(b.at ?? '') - Date.parse(a.at ?? '') || 0);
}

export function greeting(needsCount: number, now: Date = new Date()): string {
  const h = now.getHours();
  const hello = h < 5 ? 'Hello.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.';
  if (needsCount === 0) return `${hello} Nothing needs you right now.`;
  return `${hello} ${needsCount === 1 ? '1 thing needs' : `${needsCount} things need`} you.`;
}

/** "975.00 TUSDT ready to spend · 0.01 test BTC for fees". */
export function balanceSentence(d: Pick<DeskResponse, 'balances' | 'btcSats'>): string {
  const tokens = d.balances.map((b) => `${formatAmount(b.spendable, b.precision)} ${b.ticker}`).join(' + ');
  const parts: string[] = [];
  if (tokens) parts.push(`${tokens} ready to spend`);
  if (d.btcSats !== undefined && /^\d+$/.test(d.btcSats)) {
    const btc = (Number(d.btcSats) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    parts.push(
      `${btc.includes('.') && btc.split('.')[1]!.length < 2 ? Number(btc).toFixed(2) : btc} test BTC for fees`,
    );
  }
  return parts.join(' · ') || 'No tokens in your wallet yet.';
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

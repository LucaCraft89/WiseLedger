// GET /api/desk: the Money Desk home in one call. Pure code over local state (invoice store, payment requests,
// scheduled jobs, the wallet's last synced transfers and balances, /api/health problems): no model call, and the
// wallet is never synced here, so the answer stays fast and says how old the wallet state is.
import { parseInvoiceDate, safeName } from 'ai';
import {
  type AssetInfo,
  type DeskLatelyItem,
  type DeskNeedsItem,
  type DeskNeedsKind,
  type DeskResponse,
  formatAssetAmount,
  type Job,
  type TransferInfo,
} from 'core';
import type { ReceiveRequest } from './receives.js';
import type { StoredInvoice } from './store.js';

export const DESK_MAX = 5;
const MIN = 60_000;
const DAY = 86_400_000;
/** Due within this long (or overdue) → "due soon". */
export const DUE_SOON_MS = 7 * DAY;
/** An open payment request expiring within this long → "expiring". */
export const EXPIRING_MS = 60 * MIN;
/** Below this many spendable sats a payment may fail (same threshold as the startup self-check). */
export const LOW_FEE_SATS = 20_000;

/** Most urgent first; within a kind the earliest dueAt (then oldest) first. */
const URGENCY: Record<DeskNeedsKind, number> = {
  health_problem: 0,
  low_fee_balance: 1,
  request_expiring: 2,
  due_soon: 3,
  review_verdict: 4,
  awaiting_confirmation: 5,
  scheduled_today: 6,
};

export interface DeskInput {
  now: Date;
  /** Every invoice in the store. */
  invoices: readonly StoredInvoice[];
  /** Every payment request handed out. */
  receives: readonly ReceiveRequest[];
  /** Scheduled jobs still to run. */
  pendingJobs: readonly Job[];
  /** The wallet's last synced transfers ([] when not ready). */
  transfers: readonly TransferInfo[];
  /** The wallet's assets with balances ([] when not ready). */
  assets: readonly AssetInfo[];
  /** Spendable sats, when the backend exposes them. */
  feeSats?: number;
  /** /api/health problems, plain words; a "not set up / locked" wallet comes in here too. */
  problems: readonly string[];
  /** Last finished wallet sync (null on the mock wallet or before the first sync). */
  lastSyncAt: string | null;
  /** IANA zone for dates in titles (default: this machine's zone). */
  timeZone?: string;
}

type Ranked = DeskNeedsItem & { sortAt: number };

export function buildDesk(d: DeskInput): DeskResponse {
  const now = d.now.getTime();
  const assets = new Map(d.assets.map((a) => [a.assetId, a]));
  const money = (amount: string, assetId: string | undefined): string => {
    const a = assetId ? assets.get(assetId) : undefined;
    return a ? `${formatAssetAmount(amount, a.precision)} ${a.ticker}` : `${amount} base units`;
  };
  const day = (ms: number): string =>
    new Date(ms).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(d.timeZone ? { timeZone: d.timeZone } : {}),
    });
  const time = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      ...(d.timeZone ? { timeZone: d.timeZone } : {}),
    });
  const dayKey = (ms: number): string =>
    new Date(ms).toLocaleDateString('en-CA', d.timeZone ? { timeZone: d.timeZone } : {});

  const needs: Ranked[] = [];
  const add = (item: DeskNeedsItem, sortAt: number) => needs.push({ ...item, sortAt });

  d.problems.forEach((p, i) => {
    // The low-sats line of the self-check is the low_fee_balance item below.
    if (d.feeSats !== undefined && d.feeSats < LOW_FEE_SATS && /test sats; a payment needs/.test(p)) return;
    add(
      { kind: 'health_problem', id: `health-${i}`, title: p, action: { label: 'Open settings', href: '#/settings' } },
      now,
    );
  });

  if (d.feeSats !== undefined && d.feeSats < LOW_FEE_SATS) {
    add(
      {
        kind: 'low_fee_balance',
        id: 'fee-balance',
        title: `Only ${d.feeSats.toLocaleString('en-US')} test sats left for network fees; a payment needs about ${LOW_FEE_SATS.toLocaleString('en-US')}. Add test sats before your next payment.`,
        action: { label: 'Add test sats', href: '#/wallet/details' },
      },
      now,
    );
  }

  const open = d.receives.filter((r) => r.status === 'waiting' || r.status === 'incoming');
  for (const r of open) {
    const exp = Date.parse(r.expiresAt);
    if (r.status !== 'waiting' || !(exp > now && exp - now <= EXPIRING_MS)) continue;
    const mins = Math.max(1, Math.round((exp - now) / MIN));
    const what = r.amount ? `for ${money(r.amount, r.assetId)}` : 'with an open amount';
    const forWhom = r.note ? ` (${safeName(r.note)})` : '';
    add(
      {
        kind: 'request_expiring',
        id: r.receiveId,
        title: `Your payment request ${what}${forWhom} expires in ${mins} min and nobody has paid it yet. Make a new one if you still need it.`,
        dueAt: r.expiresAt,
        action: { label: 'Open request', href: `#/wallet/get-paid/${r.receiveId}` },
      },
      exp,
    );
  }

  let dueThisWeek = 0;
  for (const inv of d.invoices) {
    if (inv.state !== 'AWAITING_CONFIRMATION') continue;
    const who = supplier(inv);
    const amount = invoiceAmount(inv, money);
    const due = parseInvoiceDate(inv.report?.extraction.dueDate);
    const review = inv.report?.verdict === 'review';
    const action = review
      ? { label: 'Read the warnings', href: `#/invoice/${inv.id}` }
      : { label: 'Check and confirm', href: `#/invoice/${inv.id}` };
    if (due !== undefined && due - now <= DUE_SOON_MS) {
      dueThisWeek++;
      const when = due < now - DAY ? `was due on ${day(due)}` : `is due on ${day(due)}`;
      add(
        {
          kind: 'due_soon',
          id: inv.id,
          title: `The invoice from ${who}${amount} ${when}. ${review ? 'Read the warnings, then decide.' : 'Check it and confirm the payment.'}`,
          dueAt: new Date(due).toISOString(),
          action,
        },
        due,
      );
    } else if (review) {
      add(
        {
          kind: 'review_verdict',
          id: inv.id,
          title: `Check before paying: some details of the invoice from ${who}${amount} look unusual. Read the warnings, then decide.`,
          action,
        },
        Date.parse(inv.updatedAt),
      );
    } else {
      add(
        {
          kind: 'awaiting_confirmation',
          id: inv.id,
          title: `The invoice from ${who}${amount} is ready to pay. It waits for your OK.`,
          action,
        },
        Date.parse(inv.updatedAt),
      );
    }
  }

  const byId = new Map(d.invoices.map((i) => [i.id, i]));
  const today = dayKey(now);
  for (const job of d.pendingJobs) {
    const at = Date.parse(job.runAt);
    if (dayKey(at) !== today) continue;
    const inv = byId.get(job.invoiceId);
    add(
      {
        kind: 'scheduled_today',
        id: job.jobId,
        title: `Today at ${time(at)} we pay ${inv ? `${supplier(inv)}${invoiceAmount(inv, money)}` : 'a scheduled payment'}. Cancel it if plans changed.`,
        dueAt: job.runAt,
        action: { label: 'See scheduled payments', href: '#/schedule' },
      },
      at,
    );
  }

  needs.sort((a, b) => URGENCY[a.kind] - URGENCY[b.kind] || a.sortAt - b.sortAt);

  // Lately: what happened, newest first.
  const lately: (DeskLatelyItem & { t: number })[] = [];
  const late = (item: DeskLatelyItem) => lately.push({ ...item, t: Date.parse(item.at) });
  const linked = new Set<string>();
  for (const inv of d.invoices) {
    if (inv.result?.transferId) linked.add(inv.result.transferId);
    const who = supplier(inv);
    if (inv.state === 'PAID') {
      const amt = inv.plan ? { amount: inv.plan.amount, assetId: inv.plan.assetId } : {};
      late({
        kind: 'paid',
        id: inv.id,
        title: `Paid ${inv.plan ? `${money(inv.plan.amount, inv.plan.assetId)} ` : ''}to ${who}.`,
        ...amt,
        at: inv.updatedAt,
      });
    } else if (inv.state === 'BLOCKED') {
      late({
        kind: 'blocked',
        id: inv.id,
        title: `We stopped an invoice from ${who}. Nothing left your wallet.`,
        at: inv.updatedAt,
      });
    } else if (inv.state === 'SCHEDULED' && inv.plan && inv.plan.executeAt !== 'now') {
      const at = Date.parse(inv.plan.executeAt);
      late({
        kind: 'scheduled',
        id: inv.id,
        title: `Scheduled ${money(inv.plan.amount, inv.plan.assetId)} to ${who} for ${day(at)} at ${time(at)}.`,
        amount: inv.plan.amount,
        assetId: inv.plan.assetId,
        at: inv.confirmation?.confirmedAt ?? inv.updatedAt,
      });
    }
  }
  for (const r of d.receives) {
    if (r.status !== 'received') continue;
    if (r.transferId) linked.add(r.transferId);
    const amount = r.receivedAmount ?? r.amount;
    late({
      kind: 'received',
      id: r.receiveId,
      title: `Received ${amount ? money(amount, r.assetId) : 'a payment'}${r.note ? ` (${safeName(r.note)})` : ''}.`,
      ...(amount ? { amount } : {}),
      ...(r.assetId ? { assetId: r.assetId } : {}),
      at: r.updatedAt,
    });
  }
  // Settled transfers the app did not make from an invoice or a request (chat payments, payments from elsewhere).
  for (const t of d.transfers) {
    if (t.status !== 'Settled' || linked.has(t.transferId) || t.direction === 'issuance') continue;
    const out = t.direction === 'outgoing';
    late({
      kind: out ? 'paid' : 'received',
      id: `transfer-${t.transferId}`,
      title: `${out ? 'Paid' : 'Received'} ${money(t.amount, t.assetId)}.`,
      amount: t.amount,
      ...(t.assetId ? { assetId: t.assetId } : {}),
      at: t.settledAt ?? t.updatedAt,
    });
  }
  lately.sort((a, b) => b.t - a.t);

  const syncedMs = d.lastSyncAt ? Date.parse(d.lastSyncAt) : Number.NaN;
  const secondsAgo = Number.isNaN(syncedMs) ? undefined : Math.max(0, Math.round((now - syncedMs) / 1000));

  return {
    greetingCounts: {
      needsYou: needs.length,
      dueThisWeek,
      scheduled: d.pendingJobs.length,
      waitingToBePaid: open.length,
    },
    balances: d.assets.map((a) => ({
      assetId: a.assetId,
      ticker: a.ticker,
      spendable: a.balance.spendable,
      precision: a.precision,
    })),
    ...(d.feeSats !== undefined ? { feeSats: String(d.feeSats) } : {}),
    needsYou: needs.slice(0, DESK_MAX).map(({ sortAt: _s, ...item }) => item),
    lately: lately.slice(0, DESK_MAX).map(({ t: _t, ...item }) => item),
    updated: {
      ...(secondsAgo !== undefined ? { at: new Date(syncedMs).toISOString(), secondsAgo } : {}),
      text: secondsAgo !== undefined ? `Wallet updated ${ago(secondsAgo)}` : 'Wallet not synced yet',
    },
  };
}

function ago(s: number): string {
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** The supplier as the user should read it: cleaned, instruction-like names hidden (same rule as the Treasurer). */
function supplier(inv: StoredInvoice): string {
  const name = safeName(inv.plan?.payee.name ?? inv.report?.extraction.issuer.name);
  return name === 'Unknown supplier' ? 'an unknown supplier' : name;
}

/** " (25.00 TUSDT)" from the plan, else the total as printed, else "". */
function invoiceAmount(inv: StoredInvoice, money: (amount: string, assetId: string) => string): string {
  if (inv.plan && /^\d+$/.test(inv.plan.amount) && inv.plan.amount !== '0') {
    return ` (${money(inv.plan.amount, inv.plan.assetId)})`;
  }
  const ex = inv.report?.extraction;
  if (ex?.total && ex.currency && /^[A-Za-z]{2,8}$/.test(ex.currency)) return ` (${ex.total} ${ex.currency})`;
  return '';
}

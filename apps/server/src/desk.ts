// GET /api/desk: the Money Desk home in one call. Pure code over local state (invoice store, payment requests,
// scheduled jobs, the wallet's last synced transfers and balances, /api/health problems): no model call, and the
// wallet is never synced here, so the answer stays fast and says how old the wallet state is. Titles are in the
// owl's voice (first person, short) and built from templates per kind; amounts travel in their own fields.
import { parseInvoiceDate, safeName } from 'ai';
import {
  type AssetInfo,
  type DeskLatelyItem,
  type DeskNeedsItem,
  type DeskNeedsKind,
  type DeskResponse,
  type InvoiceState,
  type Job,
  PAYMENT_REQUEST_PAYEE,
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
/**
 * Below this many spendable sats not even one RGB send fits (env FEE_MIN_SATS): a fixed config value, not a
 * quotePay estimate (quotePay needs a real invoice to pay). Default: about 500 vB at the default 2 sat/vB.
 */
export const FEE_MIN_SATS = 1_000;

/** Most urgent first; within a kind the earliest dueAt (then oldest) first. */
const URGENCY: Record<DeskNeedsKind, number> = {
  no_fee_money: -1,
  health_problem: 0,
  low_fee_balance: 1,
  request_expiring: 2,
  due_soon: 3,
  review_verdict: 4,
  awaiting_confirmation: 5,
  scheduled_today: 6,
};

/** An analysis or a payment is running while an invoice is in one of these states. */
const BUSY_STATES: ReadonlySet<InvoiceState> = new Set(['UPLOADED', 'EXTRACTED', 'ANALYZED', 'CONFIRMED', 'EXECUTING']);

export interface DeskInput {
  now: Date;
  /** Every invoice in the store. */
  invoices: readonly StoredInvoice[];
  /** Every payment request handed out. */
  receives: readonly ReceiveRequest[];
  /** Scheduled jobs still to run. */
  pendingJobs: readonly Job[];
  /** Scheduled jobs paying right now. */
  runningJobs?: number;
  /** The wallet's last synced transfers ([] when not ready). */
  transfers: readonly TransferInfo[];
  /** The wallet's assets with balances ([] when not ready). */
  assets: readonly AssetInfo[];
  /** Spendable sats, when the backend exposes them. */
  feeSats?: number;
  /** Below this, no RGB send fits (default FEE_MIN_SATS). */
  feeMinSats?: number;
  /** /api/health problems, plain words; a "not set up / locked" wallet comes in here too. */
  problems: readonly string[];
  /** Last finished wallet sync (null on the mock wallet or before the first sync). */
  lastSyncAt: string | null;
  /** Onboarding: the user confirmed the recovery words. */
  recoveryWordsSaved?: boolean;
  /** IANA zone for dates in titles and the month (default: this machine's zone). */
  timeZone?: string;
}

type Ranked = DeskNeedsItem & { sortAt: number };

export function buildDesk(d: DeskInput): DeskResponse {
  const now = d.now.getTime();
  const assets = new Map(d.assets.map((a) => [a.assetId, a]));
  const tz = d.timeZone ? { timeZone: d.timeZone } : {};
  const day = (ms: number): string =>
    new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...tz });
  const time = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...tz });
  const dayKey = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', tz);
  const feeMin = d.feeMinSats ?? FEE_MIN_SATS;
  const noFeeMoney = d.feeSats !== undefined && d.feeSats < feeMin;
  const lowFee = d.feeSats !== undefined && d.feeSats < LOW_FEE_SATS;

  const needs: Ranked[] = [];
  const add = (item: Omit<DeskNeedsItem, 'actionLabel'>, sortAt: number) =>
    needs.push({ ...item, actionLabel: item.action.label, sortAt });

  if (noFeeMoney) {
    add(
      {
        kind: 'no_fee_money',
        id: 'no-fee-money',
        title: "I can't pay anything yet: there is no Bitcoin for fees.",
        tone: 'block',
        action: { label: 'Add Bitcoin for fees', href: '#/settings/money' },
      },
      now,
    );
  } else if (lowFee) {
    add(
      {
        kind: 'low_fee_balance',
        id: 'fee-balance',
        title: `I'm low on Bitcoin for fees: ${(d.feeSats as number).toLocaleString('en-US')} sats left.`,
        tone: 'review',
        action: { label: 'Add Bitcoin for fees', href: '#/settings/money' },
      },
      now,
    );
  }

  d.problems.forEach((p, i) => {
    // The low-sats line of the self-check is the fee item above.
    if (lowFee && /test sats; a payment needs/.test(p)) return;
    add(
      {
        kind: 'health_problem',
        id: `health-${i}`,
        title: p,
        tone: 'block',
        action: { label: 'Open settings', href: '#/settings' },
      },
      now,
    );
  });

  const open = d.receives.filter((r) => r.status === 'waiting' || r.status === 'incoming');
  for (const r of open) {
    const exp = Date.parse(r.expiresAt);
    if (r.status !== 'waiting' || !(exp > now && exp - now <= EXPIRING_MS)) continue;
    const mins = Math.max(1, Math.round((exp - now) / MIN));
    const payer = r.payer ? safeName(r.payer) : undefined;
    add(
      {
        kind: 'request_expiring',
        id: r.receiveId,
        title: payer
          ? `${payer} hasn't paid your request yet. It expires in ${mins} min.`
          : `Nobody has paid your request yet. It expires in ${mins} min.`,
        dueAt: r.expiresAt,
        tone: 'review',
        ...(r.amount ? { amount: r.amount } : {}),
        ...(r.assetId ? { assetId: r.assetId } : {}),
        action: { label: 'Open request', href: `#/get-paid/${r.receiveId}` },
      },
      exp,
    );
  }

  let dueThisWeek = 0;
  for (const inv of d.invoices) {
    if (inv.state !== 'AWAITING_CONFIRMATION') continue;
    const due = parseInvoiceDate(inv.report?.extraction.dueDate);
    const review = inv.report?.verdict === 'review';
    const money = invoiceMoney(inv, assets);
    const base = {
      id: inv.id,
      tone: review ? ('review' as const) : ('ok' as const),
      ...money,
      action: review
        ? { label: 'Read the warnings', href: `#/invoice/${inv.id}` }
        : { label: 'Check and confirm', href: `#/invoice/${inv.id}` },
    };
    if (due !== undefined && due - now <= DUE_SOON_MS) {
      dueThisWeek++;
      const when = due < now - DAY ? `was due on ${day(due)}` : `is due on ${day(due)}`;
      add({ ...base, kind: 'due_soon', title: `${whose(inv)} ${when}.`, dueAt: new Date(due).toISOString() }, due);
    } else if (review) {
      const warnings = inv.report?.flags.filter((f) => f.severity === 'warn').length ?? 0;
      const title =
        supplierOf(inv) === undefined && inv.report?.kind === 'payment_request'
          ? "A payment request from someone I don't know"
          : `${whose(inv)} has ${warnings === 1 ? '1 warning' : `${warnings || 'some'} warnings`}`;
      add({ ...base, kind: 'review_verdict', title }, Date.parse(inv.updatedAt));
    } else {
      add(
        { ...base, kind: 'awaiting_confirmation', title: `${whose(inv)} is ready to pay.` },
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
    const who = inv ? supplierOf(inv) : undefined;
    add(
      {
        kind: 'scheduled_today',
        id: job.jobId,
        title: `I'll pay ${who ?? 'a scheduled payment'} today at ${time(at)}.`,
        dueAt: job.runAt,
        tone: 'ok',
        ...(inv ? invoiceMoney(inv, assets) : {}),
        action: { label: 'See scheduled payments', href: '#/pay/scheduled' },
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
    const who = supplierOf(inv);
    const money = invoiceMoney(inv, assets);
    if (inv.state === 'PAID') {
      late({
        kind: 'paid',
        id: inv.id,
        title: `I paid ${who ?? 'the payment request'}.`,
        direction: 'out',
        stamp: 'PAID',
        ...money,
        at: inv.updatedAt,
      });
    } else if (inv.state === 'BLOCKED') {
      late({
        kind: 'blocked',
        id: inv.id,
        title: `I stopped an invoice from ${who ?? "someone I don't know"}. Nothing left your money.`,
        direction: 'none',
        stamp: 'STOPPED',
        ...money,
        at: inv.updatedAt,
      });
    } else if (inv.state === 'REJECTED' && inv.report) {
      late({
        kind: 'checked',
        id: inv.id,
        title: `I checked ${who ? `the invoice from ${who}` : 'an invoice'}. You chose not to pay it.`,
        direction: 'none',
        stamp: 'CHECKED',
        ...money,
        at: inv.updatedAt,
      });
    } else if (inv.state === 'SCHEDULED' && inv.plan && inv.plan.executeAt !== 'now') {
      const at = Date.parse(inv.plan.executeAt);
      late({
        kind: 'scheduled',
        id: inv.id,
        title: `I'll pay ${who ?? 'the payment request'} on ${day(at)} at ${time(at)}.`,
        direction: 'out',
        stamp: 'SCHEDULED',
        ...money,
        at: inv.confirmation?.confirmedAt ?? inv.updatedAt,
      });
    }
  }
  for (const r of d.receives) {
    if (r.status !== 'received') continue;
    if (r.transferId) linked.add(r.transferId);
    const amount = r.receivedAmount ?? r.amount;
    const payer = r.payer ? safeName(r.payer) : undefined;
    const purpose = r.purpose ? safeName(r.purpose) : undefined;
    late({
      kind: 'received',
      id: r.receiveId,
      title: payer
        ? `${payer} paid your request${purpose ? ` for ${purpose}` : ''}.`
        : purpose
          ? `Your request for ${purpose} was paid.`
          : 'Someone paid your request.',
      direction: 'in',
      stamp: 'RECEIVED',
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
      title: out ? 'I sent a payment.' : 'You received a payment.',
      direction: out ? 'out' : 'in',
      stamp: out ? 'PAID' : 'RECEIVED',
      amount: t.amount,
      ...(t.assetId ? { assetId: t.assetId } : {}),
      at: t.settledAt ?? t.updatedAt,
    });
  }
  lately.sort((a, b) => b.t - a.t);

  const syncedMs = d.lastSyncAt ? Date.parse(d.lastSyncAt) : Number.NaN;
  const secondsAgo = Number.isNaN(syncedMs) ? undefined : Math.max(0, Math.round((now - syncedMs) / 1000));
  const syncedAt = Number.isNaN(syncedMs) ? undefined : new Date(syncedMs).toISOString();
  const busy = (d.runningJobs ?? 0) > 0 || d.invoices.some((i) => BUSY_STATES.has(i.state));

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
      ...(syncedAt !== undefined && secondsAgo !== undefined ? { at: syncedAt, secondsAgo } : {}),
      text: secondsAgo !== undefined ? `Wallet updated ${ago(secondsAgo)}` : 'Wallet not synced yet',
    },
    mood: busy ? 'busy' : needs.length > 0 ? 'attention' : 'quiet',
    month: monthCounts(d, assets, (ms) => dayKey(ms).slice(0, 7)),
    ...(syncedAt !== undefined ? { syncedAt } : {}),
    ...(d.recoveryWordsSaved !== undefined ? { recoveryWordsSaved: d.recoveryWordsSaved } : {}),
  };
}

/** This calendar month: invoices read and stopped (a document sent twice counts once), money kept, payments. */
function monthCounts(
  d: DeskInput,
  assets: ReadonlyMap<string, AssetInfo>,
  monthOf: (ms: number) => string,
): NonNullable<DeskResponse['month']> {
  const month = monthOf(d.now.getTime());
  const inMonth = (iso: string | undefined) => iso !== undefined && monthOf(Date.parse(iso)) === month;
  const read = new Set<string>();
  const stopped = new Set<string>();
  const kept = new Map<string, bigint>();
  for (const inv of d.invoices) {
    if (!inv.report || !inMonth(inv.report.createdAt ?? inv.createdAt)) continue;
    const key = documentKey(inv);
    read.add(key);
    if (inv.state !== 'BLOCKED' || stopped.has(key)) continue;
    stopped.add(key);
    const money = invoiceMoney(inv, assets);
    if (money.amount && money.assetId) kept.set(money.assetId, (kept.get(money.assetId) ?? 0n) + BigInt(money.amount));
  }
  let paymentsMade = 0;
  let received = 0;
  for (const t of d.transfers) {
    if (t.status !== 'Settled' || t.direction === 'issuance' || !inMonth(t.settledAt ?? t.updatedAt)) continue;
    if (t.direction === 'outgoing') paymentsMade++;
    else received++;
  }
  return {
    invoicesRead: read.size,
    invoicesStopped: stopped.size,
    protectedAmount: [...kept].map(([assetId, amount]) => ({ assetId, amount: amount.toString() })),
    paymentsMade,
    received,
  };
}

/** Same supplier + invoice number = the same invoice (R4); without a number, the same file. */
function documentKey(inv: StoredInvoice): string {
  const ex = inv.report?.extraction;
  const issuer = ex?.issuer.name?.trim().toLowerCase();
  const number = ex?.invoiceNumber?.trim().toLowerCase();
  return issuer && number ? `n:${issuer}|${number}` : `h:${inv.sha256}`;
}

function ago(s: number): string {
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** The supplier as the user should read it (instruction-like names hidden), or undefined when nobody is named. */
function supplierOf(inv: StoredInvoice): string | undefined {
  const raw = inv.plan?.payee.name ?? inv.report?.extraction.issuer.name;
  if (!raw || raw === PAYMENT_REQUEST_PAYEE) return undefined;
  const name = safeName(raw);
  return name === 'Unknown supplier' ? undefined : name;
}

/** "Acme Srl's invoice", "An invoice from someone I don't know", "A payment request". */
function whose(inv: StoredInvoice): string {
  const who = supplierOf(inv);
  if (who === '[name hidden]') return 'An invoice with a hidden supplier name';
  if (who) return `${who}${/s$/i.test(who) ? "'" : "'s"} invoice`;
  return inv.report?.kind === 'payment_request' ? 'A payment request' : "An invoice from someone I don't know";
}

/**
 * What the invoice asks, in base units of a held asset: the plan, else the decoded payment request, else the
 * printed total when its currency is the ticker of exactly one held asset. {} when unknown.
 */
function invoiceMoney(
  inv: StoredInvoice,
  assets: ReadonlyMap<string, AssetInfo>,
): { amount?: string; assetId?: string } {
  if (inv.plan && /^\d+$/.test(inv.plan.amount) && inv.plan.amount !== '0') {
    return { amount: inv.plan.amount, assetId: inv.plan.assetId };
  }
  const pr = inv.report?.paymentRequest;
  if (pr?.amount && pr.assetId) return { amount: pr.amount, assetId: pr.assetId };
  const ex = inv.report?.extraction;
  if (!ex?.total || !ex.currency) return {};
  const hint = ex.payment.assetIdHint ? assets.get(ex.payment.assetIdHint) : undefined;
  const byTicker = [...assets.values()].filter((a) => a.ticker.toUpperCase() === ex.currency?.toUpperCase());
  const asset = hint ?? (byTicker.length === 1 ? byTicker[0] : undefined);
  const amount = asset ? toBaseUnits(ex.total, asset.precision) : undefined;
  return asset && amount ? { amount, assetId: asset.assetId } : {};
}

/** "25.5" at precision 6 → "25500000"; undefined for anything that is not a plain decimal. */
export function toBaseUnits(decimal: string, precision: number): string | undefined {
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(decimal.trim());
  if (!m) return undefined;
  const frac = (m[2] ?? '').slice(0, precision).padEnd(precision, '0');
  const out = `${m[1]}${frac}`.replace(/^0+(?=\d)/, '');
  return out === '0' ? undefined : out;
}

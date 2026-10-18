// Books (GET /api/books) and receipts (GET /api/receipts/:transferId), computed from the wallet's transfers and
// the local store on every call: no stored numbers that could drift from the wallet. The running balance adds the
// settled transfers in settle order; the newest settled row's balanceAfter must equal the wallet's settled balance
// (checked once after the first sync: a mismatch is logged).
import { safeName } from 'ai';
import {
  type AssetInfo,
  type BookRow,
  type BooksResponse,
  PAYMENT_REQUEST_PAYEE,
  type ReceiptResponse,
  type TransferInfo,
  type WalletPort,
} from 'core';
import type { SqliteLabelStore } from './labels.js';
import type { ReceiveRequest, SqliteReceiveStore } from './receives.js';
import type { InvoiceStore, StoredInvoice } from './store.js';

export const BOOKS_PAGE_DEFAULT = 20;
export const BOOKS_PAGE_MAX = 100;

export interface BooksSources {
  store: InvoiceStore;
  receives: SqliteReceiveStore;
  labels: SqliteLabelStore;
}

/** The payment asset: the first allowed one held, else the first NIA asset. */
export function defaultAsset(assets: readonly AssetInfo[], allowlist: readonly string[] = []): AssetInfo | undefined {
  return assets.find((a) => allowlist.includes(a.assetId)) ?? assets.find((a) => a.schema === 'NIA');
}

const settleTime = (t: TransferInfo) => Date.parse(t.settledAt ?? t.updatedAt);

/** Transfers that are money movements: not a request nobody paid (rgb-lib keeps those as incoming 0 / Failed). */
function isMovement(t: TransferInfo): boolean {
  if (t.direction !== 'incoming') return true;
  if (t.status === 'WaitingCounterparty') return false;
  return !(t.status === 'Failed' && t.amount === '0');
}

function payeeName(inv: StoredInvoice | undefined): string | undefined {
  const raw = inv?.plan?.payee.name ?? inv?.report?.extraction.issuer.name;
  if (!raw || raw === PAYMENT_REQUEST_PAYEE) return undefined;
  const name = safeName(raw);
  return name === 'Unknown supplier' ? undefined : name;
}

/**
 * Every row of one asset, oldest → newest by the time it settled (pending and failed rows by creation time), with
 * the running settled balance. `feeOf` gives the network fee in sats by txid (when the backend exposes it).
 */
export async function bookRows(
  transfers: readonly TransferInfo[],
  assetId: string,
  src: BooksSources,
  feeOf: (txid: string) => string | undefined = () => undefined,
): Promise<BookRow[]> {
  const mine = transfers.filter((t) => t.assetId === assetId && isMovement(t));
  const at = (t: TransferInfo) => (t.status === 'Settled' ? settleTime(t) : Date.parse(t.createdAt));
  mine.sort(
    (a, b) => at(a) - at(b) || a.createdAt.localeCompare(b.createdAt) || Number(a.transferId) - Number(b.transferId),
  );
  const labels = await src.labels.effectiveLabelsMap(mine.map((t) => t.transferId));
  const byTransfer = new Map<string, ReceiveRequest>();
  for (const r of src.receives.list()) if (r.transferId) byTransfer.set(r.transferId, r);

  let balance = 0n;
  return mine.map((t): BookRow => {
    const settled = t.status === 'Settled';
    const amount = BigInt(t.amount);
    if (settled) balance += t.direction === 'outgoing' ? -amount : amount;
    const invoiceId = src.store.invoiceForTransfer(t.transferId);
    const inv = invoiceId ? src.store.get(invoiceId) : undefined;
    const rcv = byTransfer.get(t.transferId);
    const fee = t.direction === 'outgoing' && t.txid ? feeOf(t.txid) : undefined;
    let kind: BookRow['kind'];
    let title: string;
    let counterparty: string | undefined;
    if (t.direction === 'issuance') {
      kind = 'issuance';
      title = 'Tokens issued to this wallet';
    } else if (t.direction === 'outgoing') {
      kind = 'payment';
      counterparty = payeeName(inv);
      const number = inv?.report?.extraction.invoiceNumber;
      title = counterparty
        ? `Paid ${counterparty}${number ? ` · invoice ${safeName(number)}` : ''}`
        : inv
          ? 'Paid a payment request'
          : 'Payment sent';
    } else {
      kind = 'receipt';
      counterparty = rcv?.payer ? safeName(rcv.payer) : undefined;
      const purpose = rcv?.purpose ? safeName(rcv.purpose) : undefined;
      title = counterparty
        ? `Received from ${counterparty}${purpose ? ` · ${purpose}` : ''}`
        : purpose
          ? `Received · ${purpose}`
          : 'Payment received';
    }
    return {
      at: new Date(at(t)).toISOString(),
      kind,
      title,
      ...(counterparty ? { counterparty } : {}),
      ...(t.direction === 'outgoing' ? { out: t.amount } : { in: t.amount }),
      ...(fee ? { fee } : {}),
      balanceAfter: settled ? balance.toString() : null,
      ...(settled || t.status === 'Failed' ? {} : { pending: true }),
      transferId: t.transferId,
      ...(invoiceId ? { invoiceId } : {}),
      ...(rcv ? { receiveId: rcv.receiveId } : {}),
      stamp: !settled
        ? t.status === 'Failed'
          ? 'FAILED'
          : 'PENDING'
        : t.direction === 'outgoing'
          ? 'PAID'
          : t.direction === 'issuance'
            ? 'ISSUED'
            : 'RECEIVED',
      labels: labels.get(t.transferId) ?? [],
    };
  });
}

/** Our side of the Lightning channels for one asset (undefined when the wallet has no Lightning rail). */
export async function lightningBalance(wallet: WalletPort, assetId: string): Promise<bigint | undefined> {
  if (!wallet.lightningStatus) return undefined;
  const ln = await wallet.lightningStatus().catch(() => undefined);
  if (!ln?.enabled) return undefined;
  return ln.channels.filter((c) => c.assetId === assetId).reduce((s, c) => s + BigInt(c.localAsset), 0n);
}

/** The last running balance (0 when nothing settled). */
export function finalBalance(rows: readonly BookRow[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = rows[i]?.balanceAfter;
    if (b != null) return b;
  }
  return '0';
}

/** One page, newest first; `before` = the transferId of the last row of the previous page. */
export function booksPage(
  rows: readonly BookRow[],
  q: { limit?: number; before?: string },
): Pick<BooksResponse, 'rows' | 'nextBefore'> {
  const limit = Math.min(Math.max(q.limit ?? BOOKS_PAGE_DEFAULT, 1), BOOKS_PAGE_MAX);
  const newest = [...rows].reverse();
  const start = q.before ? newest.findIndex((r) => r.transferId === q.before) + 1 : 0;
  if (q.before && start === 0) return { rows: [] };
  const page = newest.slice(start, start + limit);
  const last = page.at(-1);
  return { rows: page, ...(start + limit < newest.length && last?.transferId ? { nextBefore: last.transferId } : {}) };
}

/**
 * Startup self-check: for each asset, the books' final running balance against wallet.assetBalance().settled.
 * Returns one plain line per mismatch (empty = the books add up).
 */
export async function booksMismatches(wallet: WalletPort, src: BooksSources): Promise<string[]> {
  const [assets, transfers] = await Promise.all([wallet.listAssets(), wallet.listTransfers()]);
  const out: string[] = [];
  for (const a of assets) {
    const rows = await bookRows(transfers, a.assetId, src);
    const books = finalBalance(rows);
    const ln = (await lightningBalance(wallet, a.assetId)) ?? 0n;
    const settled = (BigInt((await wallet.assetBalance(a.assetId)).settled) + ln).toString();
    if (books !== settled) {
      out.push(
        `Books for ${a.ticker} (${a.assetId}) add up to ${books} base units, the wallet says ${settled} (on-chain + Lightning).`,
      );
    }
  }
  return out;
}

/** A settled payment (in or out) as a receipt; undefined for anything else (pending, failed, issuance, unknown). */
export async function buildReceipt(
  t: TransferInfo | null,
  assets: readonly AssetInfo[],
  src: BooksSources,
): Promise<ReceiptResponse | undefined> {
  if (!t || t.status !== 'Settled' || t.direction === 'issuance' || !t.assetId) return undefined;
  const asset = assets.find((a) => a.assetId === t.assetId);
  if (!asset) return undefined;
  const out = t.direction === 'outgoing';
  const invoiceId = src.store.invoiceForTransfer(t.transferId);
  const inv = invoiceId ? src.store.get(invoiceId) : undefined;
  const rcv = out ? undefined : src.receives.list().find((r) => r.transferId === t.transferId);
  const labels = await src.labels.effectiveLabelsMap([t.transferId]);
  const number = inv?.report?.extraction.invoiceNumber;
  const planId = inv?.result?.planId ?? inv?.plan?.planId;
  return {
    transferId: t.transferId,
    direction: out ? 'out' : 'in',
    payerName: out ? 'You (this wallet)' : rcv?.payer ? safeName(rcv.payer) : 'The payer (not named)',
    payeeName: out ? (payeeName(inv) ?? 'The receiver of the payment request') : 'You (this wallet)',
    ...(number ? { invoiceNumber: safeName(number) } : {}),
    amount: t.amount,
    asset: { assetId: asset.assetId, ticker: asset.ticker, precision: asset.precision },
    rail: t.rail ?? 'onchain',
    ...(t.txid ? { txid: t.txid } : {}),
    ...(t.paymentHash ? { paymentHash: t.paymentHash } : {}),
    settledAt: t.settledAt ?? t.updatedAt,
    ...(planId ? { planId } : {}),
    ...(inv?.report ? { verdict: inv.report.verdict } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(rcv ? { receiveId: rcv.receiveId } : {}),
    labels: labels.get(t.transferId) ?? [],
  };
}

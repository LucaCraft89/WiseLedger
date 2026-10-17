// Fiscal report over WalletPort.listTransfers() + the app DB (invoice links, labels): one row per transfer in a
// date range, as CSV (RFC 4180, `\n` line ends) or pretty JSON. No FX conversion: `rate`/`rateSource` stay blank
// unless a rate provider is injected.
import type { AssetInfo, FiscalFormat, FiscalReport, FiscalRow, FiscalService, TransferInfo, WalletPort } from 'core';
import type { SqliteLabelStore } from './labels.js';
import { isIsoDate } from './limits.js';
import type { InvoiceStore } from './store.js';

/** FiscalRow plus the exchange-rate columns (not in core's FiscalRow yet: core gap). */
export interface FiscalRowOut extends FiscalRow {
  rate?: string;
  rateSource?: string;
}

export interface FiscalReportOut extends FiscalReport {
  rows: FiscalRowOut[];
}

export interface FiscalOptions {
  /** Include transfers whose status is Failed (default false). */
  includeFailed?: boolean;
}

export interface WalletFiscalDeps {
  wallet: Pick<WalletPort, 'listTransfers' | 'listAssets'>;
  /** Invoice links (counterparty, invoice number). Without it those columns stay blank. */
  store?: InvoiceStore;
  /** Effective labels. Without it labels stay empty. */
  labels?: Pick<SqliteLabelStore, 'effectiveLabelsMap'>;
  /** Optional exchange rate per row (e.g. a fixed demo rate). Not used by default. */
  rateFor?: (row: FiscalRow) => { rate: string; rateSource: string } | undefined;
}

export const CSV_COLUMNS = [
  'date',
  'direction',
  'assetId',
  'ticker',
  'amount',
  'amountDisplay',
  'counterparty',
  'invoiceNumber',
  'labels',
  'transferId',
  'txid',
  'status',
  'rate',
  'rateSource',
] as const;

/** Base units → human units with every decimal of the asset's precision ("5000000", 6 → "5.000000"). */
export function toDisplayAmount(baseUnits: string, precision: number): string {
  if (!/^\d+$/.test(baseUnits) || precision === 0) return baseUnits;
  const padded = baseUnits.padStart(precision + 1, '0');
  return `${padded.slice(0, -precision)}.${padded.slice(-precision)}`;
}

/** RFC 4180 field: quoted when it holds a comma, quote, CR or LF; quotes doubled. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function reportFilename(from: string, to: string, format: FiscalFormat): string {
  return `wiseledger-report-${from}-${to}.${format}`;
}

function flat(row: FiscalRowOut): Record<(typeof CSV_COLUMNS)[number], string> {
  return {
    date: row.date,
    direction: row.direction,
    assetId: row.assetId,
    ticker: row.ticker,
    amount: row.amount,
    amountDisplay: row.amountDisplay,
    counterparty: row.counterparty ?? '',
    invoiceNumber: row.invoiceNumber ?? '',
    labels: row.labels.join('; '),
    transferId: row.transferId,
    txid: row.txid ?? '',
    status: row.status,
    rate: row.rate ?? '',
    rateSource: row.rateSource ?? '',
  };
}

export function toCsv(rows: readonly FiscalRowOut[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    const f = flat(row);
    lines.push(CSV_COLUMNS.map((c) => csvField(f[c])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Pretty JSON array; every column present (blank = ""), labels as an array. */
export function toJson(rows: readonly FiscalRowOut[]): string {
  return `${JSON.stringify(
    rows.map((r) => ({ ...flat(r), labels: r.labels })),
    null,
    2,
  )}\n`;
}

export class WalletFiscalService implements FiscalService {
  constructor(private readonly deps: WalletFiscalDeps) {}

  /** Rows for transfers whose date (UTC, from createdAt) is in [from, to], oldest first. */
  async rows(from: string, to: string, opts: FiscalOptions = {}): Promise<FiscalRowOut[]> {
    if (!isIsoDate(from) || !isIsoDate(to)) throw new RangeError('Dates must be written as YYYY-MM-DD.');
    if (from > to) throw new RangeError('The start date must be on or before the end date.');
    const [transfers, assets] = await Promise.all([this.deps.wallet.listTransfers(), this.deps.wallet.listAssets()]);
    const byAsset = new Map<string, AssetInfo>(assets.map((a) => [a.assetId, a]));
    const picked = transfers
      .map((t) => ({ t, date: t.createdAt.slice(0, 10) }))
      .filter(({ t, date }) => date >= from && date <= to && (opts.includeFailed || t.status !== 'Failed'))
      .sort((a, b) => a.t.createdAt.localeCompare(b.t.createdAt) || a.t.transferId.localeCompare(b.t.transferId));
    const labels = (await this.deps.labels?.effectiveLabelsMap(picked.map(({ t }) => t.transferId))) ?? new Map();
    return picked.map(({ t, date }) => this.row(t, date, byAsset, labels.get(t.transferId) ?? []));
  }

  private row(t: TransferInfo, date: string, assets: Map<string, AssetInfo>, labels: string[]): FiscalRowOut {
    const asset = t.assetId ? assets.get(t.assetId) : undefined;
    const store = this.deps.store;
    const invoiceId = store?.invoiceForTransfer(t.transferId);
    const inv = invoiceId ? store?.get(invoiceId) : undefined;
    const counterparty = inv?.plan?.payee.name;
    const invoiceNumber = inv?.report?.extraction?.invoiceNumber;
    const row: FiscalRow = {
      date,
      transferId: t.transferId,
      direction: t.direction,
      assetId: t.assetId ?? '',
      ticker: asset?.ticker ?? '',
      amount: t.amount,
      amountDisplay: asset ? toDisplayAmount(t.amount, asset.precision) : '',
      labels,
      status: t.status,
      ...(counterparty ? { counterparty } : {}),
      ...(invoiceNumber ? { invoiceNumber } : {}),
      ...(t.txid ? { txid: t.txid } : {}),
    };
    const rate = this.deps.rateFor?.(row);
    return rate ? { ...row, rate: rate.rate, rateSource: rate.rateSource } : row;
  }

  async report(from: string, to: string, format: FiscalFormat, opts: FiscalOptions = {}): Promise<FiscalReportOut> {
    const rows = await this.rows(from, to, opts);
    return {
      format,
      filename: reportFilename(from, to, format),
      content: format === 'csv' ? toCsv(rows) : toJson(rows),
      rows,
    };
  }
}

import type {
  AssetBalance,
  DecodedInvoice,
  DocumentKind,
  HistoryMatch,
  InvoiceExtraction,
  PayeeBookEntry,
  RiskFlag,
} from 'core';

export interface RuleConfig {
  /** Asset IDs the user accepts to pay with (ASSET_ALLOWLIST). First = default when the invoice lets the payer choose. */
  assetAllowlist: string[];
  /** Max amount per payment in base units (PAYMENT_CAP). */
  paymentCap: string;
  /** Networks accepted for RGB invoices, lower case (e.g. ['signet'] on Mutinynet, ['regtest'], ['mock']). */
  networks: string[];
  /** Ticker and precision of known assets, for comparing the printed total with the payment amount. */
  assets: Record<string, { ticker: string; precision: number }>;
  /**
   * RGB proxy servers we trust to carry the payment (RGB_TRANSPORT_ALLOWLIST, default RGB_TRANSPORT_ENDPOINT).
   * Absent = not checked.
   */
  transportAllowlist?: string[];
}

/** rpcs://host/path ≡ https://host/path (rgb-lib reports the proxy as https), lower-case host, no trailing slash. */
export function normalizeEndpoint(e: string): string {
  const m = /^([a-z]+):\/\/([^/]+)(.*)$/i.exec(e.trim());
  if (!m) return e.trim();
  const scheme = ({ rpcs: 'https', rpc: 'http' } as Record<string, string>)[(m[1] ?? '').toLowerCase()];
  return `${scheme ?? (m[1] ?? '').toLowerCase()}://${(m[2] ?? '').toLowerCase()}${(m[3] ?? '').replace(/\/+$/, '')}`;
}

/** Endpoints of the decoded request that are not on the allowlist ([] when all are known or nothing to check). */
export function unknownEndpoints(d: DecodedInvoice, allowlist: string[] | undefined): string[] {
  if (!allowlist || (d.rail ?? 'onchain') === 'lightning') return [];
  const ok = new Set(allowlist.map(normalizeEndpoint));
  return d.transportEndpoints.filter((e) => !ok.has(normalizeEndpoint(e)));
}

/** Everything a rule may look at. Built by code before the rules run; rules are pure functions of it. */
export interface RuleInput {
  /** `payment_request`: the document is only an RGB payment request (no supplier, number, dates, total). */
  kind?: DocumentKind;
  extraction: InvoiceExtraction;
  /** Result of WalletPort.decodeInvoice on the extracted RGB invoice. */
  decoded?: DecodedInvoice | { error: string };
  /** Spendable balance of the asset to be paid. */
  balance?: AssetBalance;
  /** HistoryPort.seen() matches for this invoice (already excluding itself). */
  history: HistoryMatch[];
  /** HistoryPort.payeeBook(): suppliers paid before (R5). Missing = empty book. */
  payees?: PayeeBookEntry[];
  /** Sanitized document text when available (R3, R5, R6, R7: rules are code, the LLM never sees it again). */
  sourceText?: string;
  /** Control-like text stripped from the document before the model saw it (R7). */
  removed?: string[];
  config: RuleConfig;
  now: Date;
}

export type Rule = (input: RuleInput) => RiskFlag[];

export const isDecoded = (d: RuleInput['decoded']): d is DecodedInvoice => !!d && !('error' in d);

/** Payment rail the wallet decoded (DecodedInvoice.rail, absent = on-chain). */
export const railOf = (d: DecodedInvoice): 'onchain' | 'lightning' => d.rail ?? 'onchain';

/** The asset this payment would use: from the RGB invoice, else the hint, else the default allowed asset. */
export function paymentAsset(input: RuleInput): string | undefined {
  const d = isDecoded(input.decoded) ? input.decoded : undefined;
  return d?.assetId ?? input.extraction.payment.assetIdHint ?? input.config.assetAllowlist[0];
}

/** "25.00", precision 6 → "25000000". Undefined when it does not fit the precision. */
export function toBaseUnits(decimal: string, precision: number): string | undefined {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!m) return undefined;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > precision) return undefined;
  return (BigInt(m[1] ?? '0') * 10n ** BigInt(precision) + BigInt(frac.padEnd(precision, '0') || '0')).toString();
}

/** The amount to pay in base units: the RGB invoice amount, else the printed total converted (same currency only). */
export function paymentAmount(input: RuleInput): string | undefined {
  const d = isDecoded(input.decoded) ? input.decoded : undefined;
  if (d?.amount) return d.amount;
  const asset = paymentAsset(input);
  const info = asset ? input.config.assets[asset] : undefined;
  const { total, currency } = input.extraction;
  if (info && total && currency?.toUpperCase() === info.ticker.toUpperCase()) return toBaseUnits(total, info.precision);
  return undefined;
}

/** R3 / check line for an open-amount payment request (the user types the amount before paying). */
export const OPEN_AMOUNT_MESSAGE = 'This request leaves the amount to you: you will type it before paying.';

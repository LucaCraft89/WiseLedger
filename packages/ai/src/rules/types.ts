import type { AssetBalance, DecodedInvoice, HistoryMatch, InvoiceExtraction, RiskFlag } from 'core';

export interface RuleConfig {
  /** Asset IDs the user accepts to pay with (ASSET_ALLOWLIST). First = default when the invoice lets the payer choose. */
  assetAllowlist: string[];
  /** Max amount per payment in base units (PAYMENT_CAP). */
  paymentCap: string;
  /** Networks accepted for RGB invoices, lower case (e.g. ['signet'] on Mutinynet, ['regtest'], ['mock']). */
  networks: string[];
  /** Ticker and precision of known assets, for comparing the printed total with the payment amount. */
  assets: Record<string, { ticker: string; precision: number }>;
}

/** Everything a rule may look at. Built by code before the rules run; rules are pure functions of it. */
export interface RuleInput {
  extraction: InvoiceExtraction;
  /** Result of WalletPort.decodeInvoice on the extracted RGB invoice. */
  decoded?: DecodedInvoice | { error: string };
  /** Spendable balance of the asset to be paid. */
  balance?: AssetBalance;
  /** HistoryPort.seen() matches for this invoice (already excluding itself). */
  history: HistoryMatch[];
  /** Raw document text when available (R7 only: rules are code, the LLM never sees it again). */
  sourceText?: string;
  config: RuleConfig;
  now: Date;
}

export type Rule = (input: RuleInput) => RiskFlag[];

export const isDecoded = (d: RuleInput['decoded']): d is DecodedInvoice => !!d && !('error' in d);

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

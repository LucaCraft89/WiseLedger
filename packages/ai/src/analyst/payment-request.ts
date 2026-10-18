// A document that is only an RGB payment request (a bare rgb:… or RGB Lightning string): no model call. Everything
// the report says about it comes from the wallet's decoder; supplier, number, dates and IBAN stay empty, because a
// payment request has none (a model asked to fill an invoice form would invent them).
import {
  type DecodedInvoice,
  formatAssetAmount,
  type InvoiceExtraction,
  isLightningInvoice,
  type PaymentRequestFacts,
  type RiskFlag,
  type Verdict,
} from 'core';
import { duration } from '../rules/rgb-check.js';
import type { RuleConfig } from '../rules/types.js';
import { paymentRequestsIn } from './extract.js';

/** At most this many non-space characters may remain around the request ("Please pay:" is fine, an invoice is not). */
export const PAYMENT_REQUEST_ONLY_REST = 20;

/** The one payment request when the text is nothing else of substance; undefined for an invoice. */
export function paymentRequestOnly(text: string): string | undefined {
  const found = paymentRequestsIn(text);
  if (found.length !== 1 || !found[0]) return undefined;
  const request = found[0];
  const rest = text
    .split(request)
    .join(' ')
    .replace(/lightning:/gi, '')
    .replace(/\s+/g, '');
  return rest.length < PAYMENT_REQUEST_ONLY_REST ? request : undefined;
}

/** The extraction of a payment-request-only document: the request and nothing else (never invented fields). */
export function paymentRequestExtraction(request: string): InvoiceExtraction {
  return {
    issuer: {},
    lineItems: [],
    payment: { method: isLightningInvoice(request) ? 'ln' : 'rgb', rgbInvoice: request },
    fieldConfidence: { 'payment.rgbInvoice': 1 },
  };
}

/** The decoded request as report facts; `payAssetId` = the approved token we would pay with. */
export function paymentRequestFacts(decoded: DecodedInvoice, payAssetId: string | undefined): PaymentRequestFacts {
  return {
    rail: decoded.rail ?? 'onchain',
    network: decoded.network,
    ...(decoded.assetId ? { assetId: decoded.assetId } : {}),
    ...(payAssetId ? { payAssetId } : {}),
    ...(decoded.amount ? { amount: decoded.amount } : {}),
    ...(decoded.expiresAt ? { expiresAt: decoded.expiresAt } : {}),
  };
}

export const PAYMENT_REQUEST_NOTICE =
  'This is a payment request, not an invoice. We read the amount, token and expiry directly from it. There is no supplier name or invoice number to check, so only pay if you know who sent it.';

/** The summary of a payment-request-only document, written by code from the decoded facts and the rule flags. */
export function paymentRequestSummary(
  facts: PaymentRequestFacts | undefined,
  flags: readonly RiskFlag[],
  verdict: Verdict,
  config: Pick<RuleConfig, 'assets'>,
  now: Date,
): string {
  if (!facts) {
    return `This is a payment request, not an invoice, but your wallet could not read it. Do not pay it. ${flags
      .filter((f) => f.severity === 'block')
      .map((f) => f.message)
      .join(' ')}`.trim();
  }
  const assetId = facts.assetId ?? facts.payAssetId;
  const info = assetId ? config.assets[assetId] : undefined;
  const ticker = info?.ticker ?? 'tokens';
  const what = facts.amount
    ? `${info ? formatAssetAmount(facts.amount, info.precision) : facts.amount} ${info ? ticker : 'base units'}`
    : `an amount you choose, in ${ticker}`;
  const rail = facts.rail === 'lightning' ? 'over Lightning' : 'on Bitcoin';
  const left = facts.expiresAt ? Date.parse(facts.expiresAt) - now.getTime() : undefined;
  const valid = left === undefined ? 'with no expiry' : left > 0 ? `valid for ${duration(left)}` : 'already expired';
  const head = `A payment request for ${what}, paid ${rail}, ${valid}. It names no supplier and no invoice number, so only pay it if you know who sent it.`;
  if (verdict === 'block') {
    const why = flags
      .filter((f) => f.severity === 'block')
      .map((f) => f.message)
      .join(' ');
    return `${head} Do not pay it: ${why}`;
  }
  return head;
}

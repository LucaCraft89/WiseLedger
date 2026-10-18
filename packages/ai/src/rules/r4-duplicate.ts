// R4 · already seen: same issuer + number, same file, or same RGB invoice.
// A copy that was paid or is still on its way blocks (paying again would pay twice); a copy that was only stopped
// (BLOCKED, REJECTED) warns: checking the same request again after fixing a setting must stay possible.
import { FLAG_CODES } from 'core';
import type { Rule } from './types.js';

const WHY = {
  'issuer+number': 'the same supplier and invoice number',
  sha256: 'the same file',
  rgbInvoice: 'the same payment request',
} as const;

export const r4Duplicate: Rule = ({ kind, history }) => {
  const live = history.find((m) => !m.stopped);
  const first = live ?? history[0];
  if (!first) return [];
  const what = kind === 'payment_request' ? 'this payment request' : `this invoice (${WHY[first.matchedOn]})`;
  if (!live) {
    return [
      {
        code: FLAG_CODES.R4_DUPLICATE,
        severity: 'warn',
        message: `You checked ${what} before and it was not paid. A request that comes back can be a trick: go on only if you expected it again.`,
        evidence: first.invoiceId,
      },
    ];
  }
  return [
    {
      code: FLAG_CODES.R4_DUPLICATE,
      severity: 'block',
      message: `You already received ${what}. Paying it again would pay twice.`,
      evidence: first.invoiceId,
    },
  ];
};

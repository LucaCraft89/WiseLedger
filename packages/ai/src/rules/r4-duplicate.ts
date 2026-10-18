// R4 · already seen: same issuer + number, same file, or same RGB invoice.
import { FLAG_CODES } from 'core';
import type { Rule } from './types.js';

const WHY = {
  'issuer+number': 'the same supplier and invoice number',
  sha256: 'the same file',
  rgbInvoice: 'the same payment request',
} as const;

export const r4Duplicate: Rule = ({ kind, history }) => {
  const first = history[0];
  if (!first) return [];
  return [
    {
      code: FLAG_CODES.R4_DUPLICATE,
      severity: 'block',
      message:
        kind === 'payment_request'
          ? 'You already received this payment request. Paying it again would pay twice.'
          : `You already received this invoice (${WHY[first.matchedOn]}). Paying it again would pay twice.`,
      evidence: first.invoiceId,
    },
  ];
};

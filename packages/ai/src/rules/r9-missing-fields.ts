// R9 · key fields missing, or read with low confidence (unclear scan, model unsure).
import { FLAG_CODES, type RiskFlag } from 'core';
import type { Rule } from './types.js';

export const LOW_CONFIDENCE = 0.5;

const KEY_FIELDS: { field: string; label: string }[] = [
  { field: 'issuer', label: 'supplier name' },
  { field: 'invoiceNumber', label: 'invoice number' },
  { field: 'total', label: 'total' },
  { field: 'payment.rgbInvoice', label: 'payment request' },
];

export const r9MissingFields: Rule = ({ extraction }) => {
  const flags: RiskFlag[] = [];
  const missing = [
    !extraction.issuer.name && 'supplier name',
    !extraction.invoiceNumber && 'invoice number',
    extraction.total && !extraction.currency && 'currency',
  ].filter((x): x is string => typeof x === 'string');
  if (missing.length) {
    flags.push({
      code: FLAG_CODES.R9_MISSING_FIELDS,
      severity: 'warn',
      message: `The invoice is missing the ${missing.join(', ')}. A real supplier always writes these.`,
    });
  }
  const unsure = KEY_FIELDS.filter(({ field }) => {
    const c = extraction.fieldConfidence[field];
    return c !== undefined && c > 0 && c < LOW_CONFIDENCE;
  }).map((k) => k.label);
  if (unsure.length) {
    flags.push({
      code: FLAG_CODES.R9_MISSING_FIELDS,
      severity: 'warn',
      message: `The AI was not sure it read the ${unsure.join(', ')} correctly. Compare them with the document.`,
    });
  }
  return flags;
};

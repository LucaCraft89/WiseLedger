// R6 · pressure and changed-bank-details language. Keywords in the text (EN + IT) and in the extraction's evidence
// quote; changed details together with urgency block, either alone warns. The model's boolean alone is info only.
import { FLAG_CODES, type RiskFlag } from 'core';
import type { Rule } from './types.js';

export const BANK_CHANGE: RegExp[] = [
  /\b(bank|payment|banking|account)\s+(details|information|coordinates|account)\s+(have|has)\s+(been\s+)?(changed|updated)/i,
  /\bnew\s+(bank|payment|banking|account)\s+(details|account|information)\b/i,
  /\bnew\s+iban\b/i,
  /\bdo\s+not\s+use\s+the\s+(previous|old)\b/i,
  /\b(nuov[aoie]|cambiat[aoie]|variazione)\b[^.\n]{0,30}\b(iban|coordinate\s+bancarie|conto)\b/i,
  /\b(coordinate\s+bancarie|iban)\b[^.\n]{0,20}\b(cambiat|aggiornat|variat)/i,
];
export const URGENCY: RegExp[] = [
  /\burgent(ly)?\b/i,
  /\b(pay|payment)\s+(today|immediately|now|within\s+\d+\s+hours?)\b/i,
  /\b(avoid|or\s+face)\b[^.\n]{0,25}\b(suspension|legal\s+action|penalt(y|ies)|disconnection)\b/i,
  /\bfinal\s+(notice|warning|reminder)\b/i,
  /\burgente\b/i,
  /\b(entro\s+oggi|immediatamente)\b/i,
  /\bsospensione\b/i,
];

const first = (patterns: RegExp[], text: string) => {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return undefined;
};

export const r6Pressure: Rule = ({ extraction, sourceText }) => {
  const quote = extraction.pressure?.evidence;
  const text = [sourceText, extraction.notes, quote].filter(Boolean).join('\n');
  const bank = first(BANK_CHANGE, text);
  const rush = first(URGENCY, text);
  const flag = (severity: RiskFlag['severity'], message: string, evidence?: string): RiskFlag[] => [
    { code: FLAG_CODES.R6_PRESSURE, severity, message, ...(evidence ? { evidence: evidence.slice(0, 80) } : {}) },
  ];
  if (bank && rush) {
    return flag(
      'block',
      'The invoice says the payment details changed and pushes you to pay fast. This is the most common invoice fraud. Call the supplier on a number you already know.',
      bank,
    );
  }
  if (bank)
    return flag('warn', 'The invoice says the payment details changed. Confirm with the supplier before paying.', bank);
  if (rush) return flag('warn', 'The invoice pushes you to pay in a hurry. Take your time and check it.', rush);
  if (extraction.pressure?.detected && quote) {
    return flag('info', 'The AI noticed pushy wording in this invoice.', quote);
  }
  return [];
};

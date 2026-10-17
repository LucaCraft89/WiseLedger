import { computeVerdict, type RiskFlag, type Verdict } from 'core';
import { r1RgbInvoice } from './r1-rgb-invoice.js';
import { r2Asset } from './r2-asset.js';
import { r3Amount } from './r3-amount.js';
import { r4Duplicate } from './r4-duplicate.js';
import { r5NewPayee } from './r5-new-payee.js';
import { r6Pressure } from './r6-pressure.js';
import { r7Injection } from './r7-injection.js';
import { r8Currency } from './r8-currency.js';
import { r9MissingFields } from './r9-missing-fields.js';
import { r10Dates } from './r10-dates.js';
import type { Rule, RuleInput } from './types.js';

export * from './r1-rgb-invoice.js';
export * from './r2-asset.js';
export * from './r3-amount.js';
export * from './r4-duplicate.js';
export * from './r5-new-payee.js';
export * from './r6-pressure.js';
export * from './r7-injection.js';
export * from './r8-currency.js';
export * from './r9-missing-fields.js';
export * from './r10-dates.js';
export * from './types.js';

export const RULES: Rule[] = [
  r1RgbInvoice,
  r2Asset,
  r3Amount,
  r4Duplicate,
  r5NewPayee,
  r6Pressure,
  r7Injection,
  r8Currency,
  r9MissingFields,
  r10Dates,
];

/** Runs every rule; the verdict comes from the flags only (any block → block, any warn → review). */
export function runRules(input: RuleInput, rules: Rule[] = RULES): { flags: RiskFlag[]; verdict: Verdict } {
  const flags = rules.flatMap((r) => r(input));
  return { flags, verdict: computeVerdict(flags) };
}

// R10 · date sanity: not issued in the future, due after issued, not older than a year; past due is info.
import { FLAG_CODES, type RiskFlag } from 'core';
import type { Rule } from './types.js';

const DAY = 86_400_000;

/** "2026-10-17" | "17/10/2026" | "17.10.2026" | "17-10-2026" (day first) | "17 Oct 2026" → UTC ms, else undefined. */
export function parseInvoiceDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return utc(+(m[1] ?? 0), +(m[2] ?? 0), +(m[3] ?? 0));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return utc(+(m[3] ?? 0), +(m[2] ?? 0), +(m[1] ?? 0));
  const p = Date.parse(t);
  return Number.isNaN(p) ? undefined : p;
}

function utc(y: number, mo: number, d: number): number | undefined {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return Date.UTC(y, mo - 1, d);
}

export const r10Dates: Rule = ({ extraction, now }) => {
  const flags: RiskFlag[] = [];
  const f = (severity: RiskFlag['severity'], message: string, evidence?: string) =>
    flags.push({ code: FLAG_CODES.R10_DATES, severity, message, ...(evidence ? { evidence } : {}) });
  const issued = parseInvoiceDate(extraction.issueDate);
  const due = parseInvoiceDate(extraction.dueDate);
  const t = now.getTime();
  if (issued !== undefined && issued > t + 2 * DAY)
    f('warn', 'The invoice date is in the future.', extraction.issueDate);
  if (issued !== undefined && issued < t - 365 * DAY)
    f('warn', 'The invoice is more than a year old.', extraction.issueDate);
  if (issued !== undefined && due !== undefined && due < issued) {
    f('warn', 'The due date comes before the invoice date.', `${extraction.issueDate} → ${extraction.dueDate}`);
  }
  if (due !== undefined && due < t - DAY && !flags.length)
    f('info', 'The due date has already passed.', extraction.dueDate);
  return flags;
};

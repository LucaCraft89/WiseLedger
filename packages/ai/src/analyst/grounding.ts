// Grounding: a field the model extracted is kept only if it is printed in the source text. Small models fill an
// invoice form with plausible values (supplier, number, dates, IBAN) that are not in the document; dropping them
// makes R9 report them as missing instead of the model's guess. Pure functions, one per kind of field.
import type { InvoiceExtraction } from 'core';
import { parseInvoiceDate } from '../rules/r10-dates.js';

/** XML (FatturaPA) as the text a reader sees: tags removed, so <IdPaese>IT</IdPaese><IdCodice>0123… reads IT0123…. */
export function xmlText(xml: string): string {
  return xml.replace(/<[^>]+>/g, '');
}

/** Lower case, accents kept, punctuation and whitespace removed ("ACME S.R.L." → "acmesrl"). */
const squash = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s.,;:'"`’()\-_/\\|]+/g, '');

/** Text field (invoice number, e-mail, VAT id): case-, whitespace- and punctuation-insensitive substring. */
export function groundText(value: string, source: string): boolean {
  const v = squash(value);
  return v.length > 0 && squash(source).includes(v);
}

/** Supplier name: the model's value must be inside one printed line (never the other way round). */
export function groundIssuer(value: string, source: string): boolean {
  const v = squash(value);
  return v.length > 0 && source.split('\n').some((line) => squash(line).includes(v));
}

/** IBAN / Bitcoin address: compared with spaces removed, case-insensitive. */
export function groundCode(value: string, source: string): boolean {
  const v = value.replace(/\s+/g, '').toUpperCase();
  return v.length > 0 && source.replace(/\s+/g, '').toUpperCase().includes(v);
}

/** Every number a printed token can mean: "1.234,56" / "1,234.56" / "1234,56" → 1234.56; "1.234" → 1.234 or 1234. */
export function numberReadings(token: string): number[] {
  const t = token.replace(/[^\d.,]/g, '');
  if (!/\d/.test(t)) return [];
  const out = new Set<number>();
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  const decimalAt = Math.max(lastComma, lastDot);
  // The last separator as the decimal point, the others as thousands.
  const asDecimal = decimalAt < 0 ? t : `${t.slice(0, decimalAt).replace(/[.,]/g, '')}.${t.slice(decimalAt + 1)}`;
  if (/^\d+(\.\d+)?$/.test(asDecimal)) out.add(Number(asDecimal));
  // Every separator as thousands ("1.234" in Italian = 1234), only with groups of three digits.
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) out.add(Number(t.replace(/[.,]/g, '')));
  return [...out];
}

/** Amount (total, line amount): equals a number printed in the text, in any common formatting. */
export function groundNumber(value: string, source: string): boolean {
  const target = Number(value);
  if (!Number.isFinite(target)) return false;
  for (const m of source.matchAll(/\d[\d.,]*/g)) {
    if (numberReadings(m[0].replace(/[.,]+$/, '')).some((n) => Math.abs(n - target) < 1e-9)) return true;
  }
  return false;
}

const MONTHS: Record<string, number> = {};
for (const [i, names] of [
  'jan january gen gennaio',
  'feb february febbraio',
  'mar march marzo',
  'apr april aprile',
  'may mag maggio',
  'jun june giu giugno',
  'jul july lug luglio',
  'aug august ago agosto',
  'sep sept september set settembre',
  'oct october ott ottobre',
  'nov november novembre',
  'dec december dic dicembre',
].entries()) {
  for (const n of names.split(' ')) MONTHS[n] = i + 1;
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const valid = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** Every calendar date printed in the text, as YYYY-MM-DD (both readings of an ambiguous 01/02/2026). */
export function printedDates(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (valid(mo, d)) out.add(ymd(y, mo, d));
  }
  for (const m of source.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (valid(b, a)) out.add(ymd(y, b, a)); // day first (Europe)
    if (valid(a, b)) out.add(ymd(y, a, b)); // month first, only because the printed string allows it
  }
  for (const m of source.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})\b/gi)) {
    const mo = MONTHS[(m[2] ?? '').toLowerCase()];
    if (mo && valid(mo, Number(m[1]))) out.add(ymd(Number(m[3]), mo, Number(m[1])));
  }
  for (const m of source.matchAll(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    const mo = MONTHS[(m[1] ?? '').toLowerCase()];
    if (mo && valid(mo, Number(m[2]))) out.add(ymd(Number(m[3]), mo, Number(m[2])));
  }
  return out;
}

/** Date: the model's value (ISO or as printed) is one of the dates printed in the text. */
export function groundDate(value: string, source: string): boolean {
  const ms = parseInvoiceDate(value);
  if (ms === undefined) return false;
  const d = new Date(ms);
  return printedDates(source).has(ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
}

const SYMBOLS: Record<string, string[]> = { EUR: ['€'], USD: ['$', 'US$'], GBP: ['£'], CHF: ['Fr.'], JPY: ['¥'] };

/** Currency: its code (EUR, USD, TUSDT…) or symbol (€, $, £) is printed in the text. */
export function groundCurrency(value: string, source: string): boolean {
  const code = value.trim().toUpperCase();
  if (!code) return false;
  if (new RegExp(`(^|[^A-Z])${code.replace(/[^A-Z0-9]/g, '')}([^A-Z]|$)`, 'i').test(source)) return true;
  return (SYMBOLS[code] ?? []).some((s) => source.includes(s));
}

/**
 * Drops every extracted field that is not printed in `source` and sets its confidence to 0 (R9 then reports it as
 * missing). Returns the cleaned extraction and the names of the dropped fields.
 */
export function groundExtraction(
  ext: InvoiceExtraction,
  source: string,
): { extraction: InvoiceExtraction; dropped: string[] } {
  const dropped: string[] = [];
  const conf = { ...ext.fieldConfidence };
  const check = (field: string, v: string | undefined, ok: (v: string, s: string) => boolean): string | undefined => {
    if (v === undefined) return undefined;
    if (ok(v, source)) return v;
    dropped.push(field);
    conf[field] = 0;
    return undefined;
  };
  const { invoiceNumber, issueDate, dueDate, currency, total, issuer, lineItems, payment, fieldConfidence, ...rest } =
    ext;
  void fieldConfidence;
  const { iban, address, ...pay } = payment;
  const extraction: InvoiceExtraction = {
    ...rest,
    issuer: {
      ...opt('name', check('issuer', issuer.name, groundIssuer)),
      ...opt('vatId', check('issuer.vatId', issuer.vatId, groundText)),
      ...opt('email', check('issuer.email', issuer.email, groundText)),
    },
    ...opt('invoiceNumber', check('invoiceNumber', invoiceNumber, groundText)),
    ...opt('issueDate', check('issueDate', issueDate, groundDate)),
    ...opt('dueDate', check('dueDate', dueDate, groundDate)),
    ...opt('currency', check('currency', currency, groundCurrency)),
    ...opt('total', check('total', total, groundNumber)),
    lineItems: lineItems.map(({ amount, ...line }, i) => ({
      ...line,
      ...opt('amount', check(`lineItems.${i}.amount`, amount, groundNumber)),
    })),
    payment: {
      ...pay,
      ...opt('iban', check('payment.iban', iban, groundCode)),
      ...opt('address', check('payment.address', address, groundCode)),
    },
    fieldConfidence: conf,
  };
  return { extraction, dropped };
}

function opt<K extends string, V>(key: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [key]: v }) as { [P in K]?: V };
}

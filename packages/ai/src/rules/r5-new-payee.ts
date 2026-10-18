// R5 · the supplier against the payee book: known, look-alike of a known one, or new.
// Look-alike letters from another alphabet block; a near-miss of a known name warns; a brand-new supplier is info only.
import { FLAG_CODES, type PayeeBookEntry, type RiskFlag } from 'core';
import type { Rule } from './types.js';

/** Cyrillic and Greek letters that print like Latin ones. */
const CONFUSABLE: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  І: 'I',
  Ј: 'J',
  Ѕ: 'S',
  α: 'a',
  ο: 'o',
  ρ: 'p',
  ν: 'v',
  ι: 'i',
  κ: 'k',
  τ: 't',
  υ: 'u',
  χ: 'x',
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
};
const LEGAL = new Set([
  'srl',
  'srls',
  'spa',
  'snc',
  'sas',
  'ltd',
  'llc',
  'inc',
  'gmbh',
  'ab',
  'sa',
  'sarl',
  'bv',
  'co',
  'corp',
  'limited',
]);

const deconfuse = (s: string) => [...s].map((c) => CONFUSABLE[c] ?? c).join('');

/** Comparable form of a company name: Latin look-alikes mapped, accents, punctuation and legal suffixes dropped. */
export function payeeKey(name: string): string {
  return deconfuse(name.normalize('NFKC'))
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL.has(w))
    .join(' ');
}

/** First word that mixes Latin with look-alike letters, or is written entirely in look-alikes (e.g. Cyrillic "АСМЕ"). */
export function lookalikeWord(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const word of text.normalize('NFC').split(/[^\p{L}\p{N}]+/u)) {
    const foreign = [...word].filter((c) => /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(c));
    if (!foreign.length) continue;
    const latin = /\p{Script=Latin}/u.test(word);
    if (latin || (word.length >= 3 && foreign.every((c) => c in CONFUSABLE))) return word;
  }
  // Full-width or styled letters that only look like plain ones.
  const styled = /[Ａ-ｚ]|[\u{1d400}-\u{1d6a3}]/u.exec(text);
  return styled ? styled[0] : undefined;
}

const vatKey = (v: string | undefined) => (v ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] ?? 0;
      row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length] ?? 0;
}

/** Different but confusable: one name contains the other, or they differ by at most 2 letters. */
const nearMiss = (a: string, b: string) =>
  a !== b && Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a) || distance(a, b) <= 2);

export const r5NewPayee: Rule = ({ kind, extraction, payees = [], sourceText }) => {
  const flag = (severity: RiskFlag['severity'], message: string, evidence?: string): RiskFlag[] => [
    { code: FLAG_CODES.R5_NEW_PAYEE, severity, message, ...(evidence ? { evidence: evidence.slice(0, 80) } : {}) },
  ];
  // A bare payment request names nobody: the user must know who sent it.
  if (kind === 'payment_request') return flag('warn', 'You do not know who sent this request.');
  const name = extraction.issuer.name;
  const fake = lookalikeWord(name) ?? lookalikeWord(sourceText);
  if (fake) {
    return flag(
      'block',
      'The supplier name uses look-alike letters from another alphabet. This is a common trick to imitate a supplier you know.',
      fake,
    );
  }
  if (!name) return []; // R9 reports the missing name.
  const key = payeeKey(name);
  const vat = vatKey(extraction.issuer.vatId);
  const known = payees.find((p) => payeeKey(p.name) === key);
  if (known) {
    if (vat && known.vatId && vatKey(known.vatId) !== vat) {
      return flag(
        'warn',
        `You paid ${known.name} before, but with a different VAT number. Check that this invoice really comes from them.`,
        extraction.issuer.vatId,
      );
    }
    return [];
  }
  const similar: PayeeBookEntry | undefined =
    payees.find((p) => nearMiss(payeeKey(p.name), key)) ??
    (vat ? payees.find((p) => vatKey(p.vatId) === vat) : undefined);
  if (similar) {
    return flag(
      'warn',
      `This looks like ${similar.name}, whom you paid before, but the name is not the same. Check that it really comes from them.`,
      name,
    );
  }
  return flag('info', 'You have never paid this supplier before.', name);
};

// R3 · amount > 0, ≤ spendable, ≤ cap, printed total = payment amount, total = Σ lines, amount in words = digits.
// A total in another currency than the payment is R8's job.
import { FLAG_CODES, type RiskFlag } from 'core';
import { isDecoded, OPEN_AMOUNT_MESSAGE, paymentAmount, paymentAsset, type Rule, toBaseUnits } from './types.js';

const cents = (d: string) => Math.round(Number(d) * 100);

export const r3Amount: Rule = (input) => {
  const { extraction, balance, config } = input;
  const flags: RiskFlag[] = [];
  const f = (severity: RiskFlag['severity'], message: string, evidence?: string) =>
    flags.push({ code: FLAG_CODES.R3_AMOUNT, severity, message, ...(evidence ? { evidence } : {}) });

  const amount = paymentAmount(input);
  const asset = paymentAsset(input);
  const info = asset ? config.assets[asset] : undefined;

  // A bare payment request has no printed total, lines or words to compare: only its own amount counts.
  if (input.kind === 'payment_request') {
    if (amount === undefined) {
      if (isDecoded(input.decoded) && !input.decoded.amount) f('warn', OPEN_AMOUNT_MESSAGE);
      else f('block', 'We could not work out how much to pay.');
    } else {
      const a = BigInt(amount);
      if (a <= 0n) f('block', 'The amount to pay is zero.');
      if (balance && a > BigInt(balance.spendable)) f('block', 'You do not have enough funds to pay this request.');
      if (a > BigInt(config.paymentCap)) f('block', 'The amount is above your payment limit.');
    }
    return flags;
  }

  if (amount === undefined) {
    f('block', 'We could not work out how much to pay.');
  } else {
    const a = BigInt(amount);
    if (a <= 0n) f('block', 'The amount to pay is zero.');
    if (balance && a > BigInt(balance.spendable)) f('block', 'You do not have enough funds to pay this invoice.');
    if (a > BigInt(config.paymentCap)) f('block', 'The amount is above your payment limit.');

    // Printed total vs the amount in the RGB request.
    const { total, currency } = extraction;
    if (total && info && currency) {
      if (currency.toUpperCase() === info.ticker.toUpperCase() && toBaseUnits(total, info.precision) !== amount) {
        f('block', 'The amount in the payment request is different from the total printed on the invoice.', total);
      }
    } else if (!total) {
      f('warn', 'We could not read the invoice total to compare it with the payment.');
    }
  }

  // Total = Σ line amounts (only when every line has an amount).
  const lines = extraction.lineItems;
  if (extraction.total && lines.length > 0 && lines.every((l) => l.amount !== undefined)) {
    const sum = lines.reduce((s, l) => s + cents(l.amount ?? '0'), 0);
    if (sum !== cents(extraction.total)) {
      f(
        'warn',
        'The invoice total does not match the sum of its lines.',
        `lines ${(sum / 100).toFixed(2)} ≠ total ${extraction.total}`,
      );
    }
  }

  // "Amount in words" line (English) ≠ the total in digits: one of the two was altered.
  const words = input.sourceText ? amountInWords(input.sourceText) : undefined;
  if (words && extraction.total && Math.floor(Number(extraction.total)) !== words.value) {
    f(
      'warn',
      `The amount written in words (${words.value}) is different from the total in digits (${extraction.total}). Ask the supplier which one is right.`,
      words.text,
    );
  }
  return flags;
};

const SMALL: Record<string, number> = Object.fromEntries(
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'
    .split(' ')
    .map((w, i) => [w, i]),
);
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = { thousand: 1_000, million: 1_000_000 };

/** Integer part of an English number in words ("four hundred fifty-two") or undefined. Stops at the first other word. */
export function wordsToNumber(text: string): number | undefined {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of text
    .toLowerCase()
    .replace(/-/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)) {
    if (w === 'and' && seen) continue;
    const v = SMALL[w] ?? TENS[w];
    if (v !== undefined) current += v;
    else if (w === 'hundred' && seen) current *= 100;
    else if (SCALES[w] && seen) {
      total += current * (SCALES[w] ?? 1);
      current = 0;
    } else break;
    seen = true;
  }
  return seen ? total + current : undefined;
}

/** The value of a printed "amount in words: …" line, if it parses. */
export function amountInWords(text: string): { value: number; text: string } | undefined {
  const m = /\b(?:amount|total|sum)\s+in\s+words\s*[:-]\s*([^\n]+)/i.exec(text);
  const value = m?.[1] ? wordsToNumber(m[1]) : undefined;
  return value === undefined || !m?.[1] ? undefined : { value, text: m[1].trim().slice(0, 80) };
}

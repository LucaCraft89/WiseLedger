// R3 · amount > 0, ≤ spendable, ≤ cap, printed total = payment amount, total = Σ lines.
import { FLAG_CODES, type RiskFlag } from 'core';
import { paymentAmount, paymentAsset, type Rule, toBaseUnits } from './types.js';

const cents = (d: string) => Math.round(Number(d) * 100);

export const r3Amount: Rule = (input) => {
  const { extraction, balance, config } = input;
  const flags: RiskFlag[] = [];
  const f = (severity: RiskFlag['severity'], message: string, evidence?: string) =>
    flags.push({ code: FLAG_CODES.R3_AMOUNT, severity, message, ...(evidence ? { evidence } : {}) });

  const amount = paymentAmount(input);
  const asset = paymentAsset(input);
  const info = asset ? config.assets[asset] : undefined;

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
      if (currency.toUpperCase() === info.ticker.toUpperCase()) {
        if (toBaseUnits(total, info.precision) !== amount) {
          f('block', 'The amount in the payment request is different from the total printed on the invoice.', total);
        }
      } else {
        f(
          'warn',
          `The invoice total is in ${currency}, the payment is in ${info.ticker}: check the amount yourself.`,
          `${total} ${currency}`,
        );
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
  return flags;
};

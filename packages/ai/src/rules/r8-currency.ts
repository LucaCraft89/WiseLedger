// R8 · the invoice total is in another currency than the asset paid: the user must check the rate.
import { FLAG_CODES } from 'core';
import { paymentAmount, paymentAsset, type Rule } from './types.js';

export const r8Currency: Rule = (input) => {
  const { extraction, config } = input;
  const asset = paymentAsset(input);
  const info = asset ? config.assets[asset] : undefined;
  const { total, currency } = extraction;
  if (!total || !currency || !info || currency.toUpperCase() === info.ticker.toUpperCase()) return [];
  const amount = paymentAmount(input);
  const pay = amount ? `${(Number(amount) / 10 ** info.precision).toFixed(2)} ${info.ticker}` : info.ticker;
  return [
    {
      code: FLAG_CODES.R8_CURRENCY,
      severity: 'warn',
      message: `The invoice total is ${total} ${currency}, but you would pay ${pay}. Which exchange rate did the supplier use?`,
      evidence: `${total} ${currency}`,
    },
  ];
};

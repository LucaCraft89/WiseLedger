// "Payment request check": every check on the RGB payment request as a list, passed ones included, for the report.
// Code only, from the same inputs the rules see. A failing line names the flag that already explains it.
import { FLAG_CODES, formatAssetAmount, isLightningInvoice, type RgbCheckLine, type Verdict } from 'core';
import { networkAccepted } from './r1-rgb-invoice.js';
import { SOON_MS } from './r11-rgb-request.js';
import {
  isDecoded,
  OPEN_AMOUNT_MESSAGE,
  paymentAmount,
  paymentAsset,
  type RuleInput,
  toBaseUnits,
  unknownEndpoints,
} from './types.js';

const line = (check: RgbCheckLine['check'], result: Verdict, text: string, flagCode?: string): RgbCheckLine => ({
  check,
  result,
  text,
  ...(result !== 'ok' && flagCode ? { flagCode } : {}),
});

/** "about 2 hours" / "about 40 minutes" / "about 3 days". */
export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 90) return `about ${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  if (h < 48) return `about ${h} hours`;
  return `about ${Math.round(h / 24)} days`;
}

/** Absent when the invoice carries no RGB payment request at all (R1 already says so). */
export function rgbRequestCheck(input: RuleInput): RgbCheckLine[] | undefined {
  const { extraction, decoded, config, now } = input;
  const inv = extraction.payment.rgbInvoice;
  if (!inv) return undefined;
  const { R1_RGB_INVOICE: R1, R2_ASSET: R2, R3_AMOUNT: R3, R8_CURRENCY: R8, R11_RGB_REQUEST: R11 } = FLAG_CODES;
  if (!isDecoded(decoded)) return [line('decodes', 'block', 'Your wallet could not read the payment request.', R1)];

  const out: RgbCheckLine[] = [line('decodes', 'ok', 'Your wallet read the payment request.')];
  const ln = (decoded.rail ?? 'onchain') === 'lightning';
  out.push(
    ln === isLightningInvoice(inv)
      ? line(
          'rail',
          'ok',
          ln ? 'It is a Lightning payment request, as printed.' : 'It is a Bitcoin payment request, as printed.',
        )
      : line('rail', 'block', 'Your wallet read it as a different kind of payment than the one printed.', R1),
  );
  out.push(
    networkAccepted(config.networks, decoded.network)
      ? line('network', 'ok', 'It is for the network this wallet uses.')
      : line('network', 'block', `It is for another network (${decoded.network}).`, R1),
  );

  const left = decoded.expiresAt ? Date.parse(decoded.expiresAt) - now.getTime() : undefined;
  out.push(
    left === undefined
      ? line('not_expired', 'ok', 'It has no expiry date.')
      : left <= 0
        ? line('not_expired', 'block', 'It has expired.', R1)
        : left < SOON_MS
          ? line('not_expired', 'review', `It expires in ${duration(left)}.`, R11)
          : line('not_expired', 'ok', `It is still valid (for ${duration(left)} when we checked).`),
  );

  if (decoded.alreadyPaid !== undefined && !ln) {
    out.push(
      decoded.alreadyPaid
        ? line('not_used', 'block', 'Someone already paid it: a payment request can be paid only once.', R1)
        : line('not_used', 'ok', 'Nobody has paid it yet (its delivery server holds no payment for it).'),
    );
  }

  const asset = paymentAsset(input);
  const info = asset ? config.assets[asset] : undefined;
  const name = info?.ticker ?? 'the token';
  out.push(
    !asset
      ? line('asset_approved', 'block', 'No token you accept is set up to pay it.', R2)
      : !config.assetAllowlist.includes(asset)
        ? line('asset_approved', 'block', 'It asks for a token you have not approved.', R2)
        : line(
            'asset_approved',
            'ok',
            `It asks for ${name}, a token you approved, identified by its contract, not its name.`,
          ),
  );
  const hint = extraction.payment.assetIdHint;
  out.push(
    hint && decoded.assetId && hint !== decoded.assetId
      ? line('asset_matches', 'block', 'The token written on the invoice is different from the one in the request.', R2)
      : !decoded.assetId
        ? line('asset_matches', 'ok', `The request lets you choose the token; we use ${name}.`)
        : line(
            'asset_matches',
            'ok',
            hint
              ? 'The token written on the invoice is the one in the request.'
              : 'The request names the token by its contract.',
          ),
  );

  const amount = paymentAmount(input);
  const { total, currency } = extraction;
  const sameCurrency = !!info && !!currency && currency.toUpperCase() === info.ticker.toUpperCase();
  let amountLine: RgbCheckLine;
  if (input.kind === 'payment_request')
    amountLine = decoded.amount
      ? line(
          'amount_matches',
          'ok',
          `The amount comes from the request itself${info ? ` (${formatAssetAmount(decoded.amount, info.precision)} ${info.ticker})` : ''}.`,
        )
      : line('amount_matches', 'review', OPEN_AMOUNT_MESSAGE, R3);
  else if (amount === undefined)
    amountLine = line('amount_matches', 'block', 'We could not work out how much to pay.', R3);
  else if (total && info && currency && !sameCurrency)
    amountLine = line(
      'amount_matches',
      'review',
      `The printed total is in ${currency}, not in ${info.ticker}: check the amount.`,
      R8,
    );
  else if (!decoded.amount)
    amountLine = line(
      'amount_matches',
      'ok',
      'The payment request leaves the amount to you; we will pay the printed total.',
    );
  else if (!total)
    amountLine = line('amount_matches', 'review', 'We could not read the printed total to compare it.', R3);
  else if (!sameCurrency)
    amountLine = line('amount_matches', 'review', 'We could not read the currency of the printed total to compare it.');
  else if (info && toBaseUnits(total, info.precision) !== decoded.amount)
    amountLine = line('amount_matches', 'block', 'The amount in the request is different from the printed total.', R3);
  else
    amountLine = line(
      'amount_matches',
      'ok',
      `The amount in the request matches the printed total (${total} ${currency ?? ''}).`.replace(' )', ')'),
    );
  out.push(amountLine);

  if (ln) out.push(line('transport_known', 'ok', 'It is paid over a Lightning channel: no delivery server is needed.'));
  else if (config.transportAllowlist) {
    const known =
      unknownEndpoints(decoded, config.transportAllowlist).length === 0 && decoded.transportEndpoints.length > 0;
    out.push(
      known
        ? line('transport_known', 'ok', 'It routes the payment through a server we know.')
        : line('transport_known', 'review', 'It routes the payment through a server we do not know.', R11),
    );
  }
  return out;
}

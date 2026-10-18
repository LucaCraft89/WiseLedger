// R1 · the RGB invoice (on-chain rgb:… or RGB Lightning) decodes, is for our network and has not expired.
import { FLAG_CODES, isLightningInvoice, type RiskFlag } from 'core';
import { isDecoded, type Rule, railOf } from './types.js';

const NETWORK_ALIASES: Record<string, string> = { mutinynet: 'signet', bitcoinsignet: 'signet' };
const norm = (n: string) => {
  const k = n.toLowerCase().replace(/[^a-z]/g, '');
  return NETWORK_ALIASES[k] ?? k;
};

/** The decoded network is one the config accepts (Mutinynet reports `signet`). */
export const networkAccepted = (networks: string[], network: string): boolean =>
  networks.map(norm).includes(norm(network));

export const r1RgbInvoice: Rule = ({ extraction, decoded, config, now }) => {
  const flag = (message: string, evidence?: string): RiskFlag => ({
    code: FLAG_CODES.R1_RGB_INVOICE,
    severity: 'block',
    message,
    ...(evidence ? { evidence: evidence.slice(0, 80) } : {}),
  });
  const inv = extraction.payment.rgbInvoice;
  if (!inv) return [flag('This invoice has no RGB payment request, so it cannot be paid from this wallet.')];
  const printedLn = isLightningInvoice(inv);
  const what = printedLn ? 'Lightning payment request' : 'RGB payment request';
  if (!isDecoded(decoded)) {
    return [
      flag(
        printedLn
          ? 'The Lightning payment request on this invoice could not be read, or Lightning is off in this wallet.'
          : 'The RGB payment request on this invoice is not valid.',
        inv,
      ),
    ];
  }
  // Same string, two readings: the wallet must agree on the rail the invoice shows.
  if ((railOf(decoded) === 'lightning') !== printedLn) {
    return [flag(`The wallet read this ${what} as a different kind of payment. Ask the supplier for a new one.`, inv)];
  }
  if (!networkAccepted(config.networks, decoded.network)) {
    return [flag(`The ${what} is for another network (${decoded.network}).`, inv)];
  }
  if (decoded.expiresAt && Date.parse(decoded.expiresAt) <= now.getTime()) {
    return [flag(`The ${what} has expired. Ask the supplier for a new one.`, decoded.expiresAt)];
  }
  // Its RGB proxy already holds a payment for it: someone paid it, and a request is paid once.
  if (decoded.alreadyPaid) {
    return [flag(`This ${what} was already paid by someone. A request can be paid only once: ask for a new one.`)];
  }
  return [];
};

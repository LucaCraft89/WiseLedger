// R1 · the RGB invoice decodes, is for our network and has not expired.
import { FLAG_CODES, type RiskFlag } from 'core';
import { isDecoded, type Rule } from './types.js';

const NETWORK_ALIASES: Record<string, string> = { mutinynet: 'signet', bitcoinsignet: 'signet' };
const norm = (n: string) => {
  const k = n.toLowerCase().replace(/[^a-z]/g, '');
  return NETWORK_ALIASES[k] ?? k;
};

export const r1RgbInvoice: Rule = ({ extraction, decoded, config, now }) => {
  const flag = (message: string, evidence?: string): RiskFlag => ({
    code: FLAG_CODES.R1_RGB_INVOICE,
    severity: 'block',
    message,
    ...(evidence ? { evidence: evidence.slice(0, 80) } : {}),
  });
  const inv = extraction.payment.rgbInvoice;
  if (!inv) return [flag('This invoice has no RGB payment request, so it cannot be paid from this wallet.')];
  if (!isDecoded(decoded)) return [flag('The RGB payment request on this invoice is not valid.', inv)];
  if (!config.networks.map(norm).includes(norm(decoded.network))) {
    return [flag(`The RGB payment request is for another network (${decoded.network}).`, inv)];
  }
  if (decoded.expiresAt && Date.parse(decoded.expiresAt) <= now.getTime()) {
    return [flag('The RGB payment request has expired. Ask the supplier for a new one.', decoded.expiresAt)];
  }
  return [];
};

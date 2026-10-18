// R11 · the RGB payment request routes through a proxy server we know, and does not expire in the next 15 minutes.
// Expired requests are R1's job (block); expiry after the due date is fine.
import { FLAG_CODES, type RiskFlag } from 'core';
import { isDecoded, type Rule, unknownEndpoints } from './types.js';

export const SOON_MS = 15 * 60_000;

export const r11RgbRequest: Rule = ({ decoded, config, now }) => {
  if (!isDecoded(decoded)) return [];
  const flags: RiskFlag[] = [];
  const unknown = unknownEndpoints(decoded, config.transportAllowlist);
  if (
    unknown.length > 0 ||
    (config.transportAllowlist && decoded.rail !== 'lightning' && !decoded.transportEndpoints.length)
  ) {
    flags.push({
      code: FLAG_CODES.R11_RGB_REQUEST,
      severity: 'warn',
      message: 'This payment request routes through a server we do not know.',
      ...(unknown[0] ? { evidence: unknown[0].slice(0, 80) } : {}),
    });
  }
  const left = decoded.expiresAt ? Date.parse(decoded.expiresAt) - now.getTime() : Number.POSITIVE_INFINITY;
  if (left > 0 && left < SOON_MS) {
    flags.push({
      code: FLAG_CODES.R11_RGB_REQUEST,
      severity: 'warn',
      message: "The supplier's payment request expires very soon; pay now or ask for a new one.",
      evidence: decoded.expiresAt,
    });
  }
  return flags;
};

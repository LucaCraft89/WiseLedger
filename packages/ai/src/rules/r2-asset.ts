// R2 · the asset is one we accept, and matches what the invoice says.
import { FLAG_CODES } from 'core';
import { isDecoded, paymentAsset, type Rule } from './types.js';

export const r2Asset: Rule = (input) => {
  const { decoded, extraction, config } = input;
  const asset = paymentAsset(input);
  if (!asset) {
    return [
      { code: FLAG_CODES.R2_ASSET, severity: 'block', message: 'No accepted asset is set up to pay this invoice.' },
    ];
  }
  if (!config.assetAllowlist.includes(asset)) {
    return [
      {
        code: FLAG_CODES.R2_ASSET,
        severity: 'block',
        message: 'The invoice asks to be paid with an asset you have not approved.',
        evidence: asset.slice(0, 80),
      },
    ];
  }
  const hint = extraction.payment.assetIdHint;
  if (isDecoded(decoded) && decoded.assetId && hint && hint !== decoded.assetId) {
    return [
      {
        code: FLAG_CODES.R2_ASSET,
        severity: 'block',
        message: 'The asset written on the invoice is different from the one in its payment request.',
        evidence: hint.slice(0, 80),
      },
    ];
  }
  return [];
};

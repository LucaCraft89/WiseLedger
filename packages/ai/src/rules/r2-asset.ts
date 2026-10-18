// R2 · the asset is one we accept, and matches what the invoice says.
import { FLAG_CODES } from 'core';
import { isDecoded, paymentAsset, type Rule } from './types.js';

const short = (id: string): string => (id.length > 22 ? `${id.slice(0, 22)}…` : id);

/** Names both contracts: a token is its contract ID, so a look-alike "TUSDT" from another contract is another token. */
function notApproved(asset: string, allowlist: string[], assets: Record<string, { ticker: string }>): string {
  const mine = allowlist[0];
  if (!mine) return 'The invoice asks to be paid with an asset you have not approved.';
  const ticker = assets[mine]?.ticker;
  const yours = ticker ? `${ticker} (contract ${short(mine)})` : `contract ${short(mine)}`;
  return (
    `The invoice asks for a token from contract ${short(asset)}, which you have not approved. You pay with ${yours}. ` +
    'A token is its contract, not its name: a token with the same name from another contract is a different token.'
  );
}

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
        message: notApproved(asset, config.assetAllowlist, config.assets),
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

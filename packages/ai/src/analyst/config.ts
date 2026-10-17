import type { RuleConfig } from '../rules/types.js';

/** Rule config from env (ASSET_ALLOWLIST comma-separated, PAYMENT_CAP base units, RGB_NETWORK). */
export function ruleConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  assets: RuleConfig['assets'] = {},
): RuleConfig {
  const network = env.RGB_NETWORK ?? 'mutinynet';
  const allow = (env.ASSET_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    assetAllowlist: allow.length ? allow : Object.keys(assets),
    paymentCap: env.PAYMENT_CAP && /^\d+$/.test(env.PAYMENT_CAP) ? env.PAYMENT_CAP : '100000000',
    networks:
      env.WALLET_BACKEND === 'mock' || !env.WALLET_BACKEND
        ? ['mock', network === 'mutinynet' ? 'signet' : network]
        : [network === 'mutinynet' ? 'signet' : network],
    assets,
  };
}

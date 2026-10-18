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
    transportAllowlist: transportAllowlistFromEnv(env),
  };
}

/**
 * RGB_TRANSPORT_ALLOWLIST (comma-separated), else RGB_TRANSPORT_ENDPOINT, else the network's default proxy. The mock
 * wallet's own transport is always accepted on the mock backend.
 */
export function transportAllowlistFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const list = (env.RGB_TRANSPORT_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fallback =
    env.RGB_TRANSPORT_ENDPOINT?.trim() ||
    (env.RGB_NETWORK === 'regtest' ? 'rpc://127.0.0.1:3000/json-rpc' : 'rpcs://proxy.kaleidoswap.com/json-rpc');
  const out = list.length ? list : [fallback];
  return env.WALLET_BACKEND === 'mock' || !env.WALLET_BACKEND ? ['mock://transport', ...out] : out;
}

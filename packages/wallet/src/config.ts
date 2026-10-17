// Wallet configuration from env. Endpoints are always explicit: the wdk-wallet-rgb defaults for 'signet' do not work.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: relative data dirs resolve here, not against the cwd (pnpm -F runs scripts inside the package). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export type WalletBackendName = 'mock' | 'wdk-rgb' | 'rgb-lib';
export type RgbNetworkName = 'mutinynet' | 'regtest';

export interface WalletConfig {
  backend: WalletBackendName;
  network: RgbNetworkName;
  /** One wallet = one data dir = one process. The mnemonic lives in `<dataDir>/mnemonic` (0600). */
  dataDir: string;
  indexerUrl: string;
  transportEndpoint: string;
  explorerUrl: string;
  /** sat/vB, always passed to the chain (the estimate is 0 on Mutinynet) */
  feeRate: number;
  /** Max base units per payment, enforced by the WDK spend policy (PAYMENT_CAP, default 100 TUSDT). */
  paymentCap: string;
  /** Asset IDs allowed for payments (ASSET_ALLOWLIST, comma-separated); empty = any. */
  assetAllowlist: string[];
  /** Max base units per asset in a rolling 24 h (DAILY_CAP, default 5 × PAYMENT_CAP). */
  dailyCap: string;
}

const DEFAULTS: Record<RgbNetworkName, Pick<WalletConfig, 'indexerUrl' | 'transportEndpoint' | 'explorerUrl'>> = {
  mutinynet: {
    indexerUrl: 'https://esplora.signet.kaleidoswap.com',
    transportEndpoint: 'rpcs://proxy.kaleidoswap.com/json-rpc',
    explorerUrl: 'https://mutinynet.com',
  },
  regtest: {
    // infra/regtest/compose.yaml: electrs + rgb-proxy-server on localhost
    indexerUrl: 'tcp://127.0.0.1:50001',
    transportEndpoint: 'rpc://127.0.0.1:3000/json-rpc',
    explorerUrl: '',
  },
};

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const v = (value ?? '').trim() || fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${name}=${v} is not valid. Use one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

/** Reads WALLET_BACKEND, RGB_NETWORK, <prefix>_DATA_DIR, RGB_INDEXER_URL, RGB_TRANSPORT_ENDPOINT, RGB_EXPLORER_URL, RGB_FEE_RATE. */
export function walletConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { dataDirVar?: string; defaultDataDir?: string } = {},
): WalletConfig {
  const backend = oneOf('WALLET_BACKEND', env.WALLET_BACKEND, ['mock', 'wdk-rgb', 'rgb-lib'] as const, 'mock');
  const network = oneOf('RGB_NETWORK', env.RGB_NETWORK, ['mutinynet', 'regtest'] as const, 'mutinynet');
  const d = DEFAULTS[network];
  const feeRate = Number(env.RGB_FEE_RATE ?? '2');
  if (!Number.isFinite(feeRate) || feeRate < 1)
    throw new Error(`RGB_FEE_RATE=${env.RGB_FEE_RATE} must be a number ≥ 1.`);
  const paymentCap = (env.PAYMENT_CAP ?? '').trim() || '100000000';
  if (!/^[1-9]\d*$/.test(paymentCap))
    throw new Error(`PAYMENT_CAP=${paymentCap} must be base units (a positive integer).`);
  const dailyCap = (env.DAILY_CAP ?? '').trim() || (BigInt(paymentCap) * 5n).toString();
  if (!/^[1-9]\d*$/.test(dailyCap)) throw new Error(`DAILY_CAP=${dailyCap} must be base units (a positive integer).`);
  const assetAllowlist = (env.ASSET_ALLOWLIST ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const dataDirVar = opts.dataDirVar ?? 'WALLET_DATA_DIR';
  return {
    backend,
    network,
    dataDir: path.resolve(REPO_ROOT, env[dataDirVar] || opts.defaultDataDir || '.data/wallet'),
    indexerUrl: env.RGB_INDEXER_URL || d.indexerUrl,
    transportEndpoint: env.RGB_TRANSPORT_ENDPOINT || d.transportEndpoint,
    explorerUrl: env.RGB_EXPLORER_URL || d.explorerUrl,
    feeRate,
    paymentCap,
    assetAllowlist,
    dailyCap,
  };
}

/** Name the libraries use for the chain: Mutinynet is a signet. */
export function libNetwork(network: RgbNetworkName): 'signet' | 'regtest' {
  return network === 'mutinynet' ? 'signet' : 'regtest';
}

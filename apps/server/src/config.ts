// Server configuration from env. Unsupported values fail fast at startup with a plain message.
import { fileURLToPath } from 'node:url';
import { transportAllowlistFromEnv } from 'ai';

export interface ServerConfig {
  port: number;
  host: string;
  llmProvider: 'qvac' | 'openai' | 'mock';
  walletBackend: 'mock' | 'wdk-rgb';
  rgbNetwork: 'mutinynet' | 'regtest';
  uploadDir: string;
  /** Largest accepted upload in MB (env UPLOAD_MAX_MB, default 10). */
  uploadMaxMb: number;
  /** Asset IDs the user accepts to pay with (env ASSET_ALLOWLIST, comma-separated). Empty = the one NIA asset held. */
  assetAllowlist: string[];
  /** Max amount per payment in base units (env PAYMENT_CAP). */
  paymentCap: string;
  /** Max amount per asset in a rolling 24 h in base units (env DAILY_CAP, default 5 × PAYMENT_CAP). */
  dailyCap: string;
  /** Background wallet sync period for the real backend (env WALLET_SYNC_MS, default 15000). */
  walletSyncMs: number;
  /** Background sync period while nothing is pending (each sync blocks the server 1–5 s on Mutinynet). */
  walletSyncIdleMs: number;
  /** SQLite file (env DB_PATH), or `:memory:`. */
  dbPath: string;
  /** MockWallet status step and MockAnalyzer stage delay, in ms. */
  mockStepMs: number;
  /**
   * RGB proxy servers a payment request may route through without a warning (env RGB_TRANSPORT_ALLOWLIST,
   * comma-separated; default RGB_TRANSPORT_ENDPOINT or the network's default proxy). Absent = not checked.
   */
  transportAllowlist?: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Repo root: apps/server/src → ../../.. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_UPLOAD_DIR = fileURLToPath(new URL('../../../.data/uploads/', import.meta.url));
export const DEFAULT_DB_PATH = fileURLToPath(new URL('../../../.data/app.db', import.meta.url));

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  const value = raw === undefined || raw === '' ? fallback : raw;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(
      `${name}=${value} is not supported yet. Allowed values now: ${allowed.join(', ')}. Set ${name} in .env or the shell.`,
    );
  }
  return value as T;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name}=${raw} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

function baseUnits(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ConfigError(`${name}=${raw} must be an amount in base units, digits only (5000000 = 5 TUSDT).`);
  }
  return raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: int(env, 'PORT', 8787, 0, 65535),
    host: env.HOST?.trim() || '127.0.0.1',
    llmProvider: oneOf(env, 'LLM_PROVIDER', ['qvac', 'openai', 'mock'] as const, 'mock'),
    walletBackend: oneOf(env, 'WALLET_BACKEND', ['mock', 'wdk-rgb'] as const, 'mock'),
    rgbNetwork: oneOf(env, 'RGB_NETWORK', ['mutinynet', 'regtest'] as const, 'mutinynet'),
    uploadDir: env.UPLOAD_DIR?.trim() || DEFAULT_UPLOAD_DIR,
    uploadMaxMb: int(env, 'UPLOAD_MAX_MB', 10, 1, 200),
    assetAllowlist: (env.ASSET_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    paymentCap: baseUnits(env, 'PAYMENT_CAP', '100000000'),
    dailyCap: baseUnits(env, 'DAILY_CAP', (BigInt(baseUnits(env, 'PAYMENT_CAP', '100000000')) * 5n).toString()),
    walletSyncMs: int(env, 'WALLET_SYNC_MS', 15_000, 1000),
    walletSyncIdleMs: int(env, 'WALLET_SYNC_IDLE_MS', 60_000, 1000),
    dbPath: env.DB_PATH?.trim() || DEFAULT_DB_PATH,
    mockStepMs: int(env, 'MOCK_STEP_MS', 1000),
    transportAllowlist: transportAllowlistFromEnv(env),
  };
}

// Server configuration from env. Only the mock backends exist in M0: any other value fails fast at startup.
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  host: string;
  llmProvider: 'mock';
  walletBackend: 'mock';
  rgbNetwork: 'mutinynet' | 'regtest';
  uploadDir: string;
  /** SQLite file (env DB_PATH), or `:memory:`. */
  dbPath: string;
  /** MockWallet status step and MockAnalyzer stage delay, in ms. */
  mockStepMs: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: int(env, 'PORT', 8787, 0, 65535),
    host: env.HOST?.trim() || '127.0.0.1',
    llmProvider: oneOf(env, 'LLM_PROVIDER', ['mock'] as const, 'mock'),
    walletBackend: oneOf(env, 'WALLET_BACKEND', ['mock'] as const, 'mock'),
    rgbNetwork: oneOf(env, 'RGB_NETWORK', ['mutinynet', 'regtest'] as const, 'mutinynet'),
    uploadDir: env.UPLOAD_DIR?.trim() || DEFAULT_UPLOAD_DIR,
    dbPath: env.DB_PATH?.trim() || DEFAULT_DB_PATH,
    mockStepMs: int(env, 'MOCK_STEP_MS', 1000),
  };
}

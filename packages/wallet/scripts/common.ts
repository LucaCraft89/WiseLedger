// Shared helpers for wallet scripts: env loading, wallet opening, plain output. Seeds are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { WdkRgbWallet } from '../src/backend/wdk-rgb.js';
import { walletConfigFromEnv } from '../src/config.js';

/** Repo root (scripts run with cwd = packages/wallet under pnpm -F). */
export const repoRoot = path.resolve(import.meta.dirname, '../../..');

/** Loads <repo>/.env into process.env without overriding existing variables. */
export function loadDotEnv(): void {
  const file = path.join(repoRoot, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]?.replace(/^["']|["']$/g, '');
  }
}

export type Role = 'payer' | 'payee';

export async function openWallet(role: Role): Promise<WdkRgbWallet> {
  loadDotEnv();
  const dataDirVar = role === 'payer' ? 'WALLET_DATA_DIR' : 'PAYEE_DATA_DIR';
  const dataDir = path.resolve(repoRoot, process.env[dataDirVar] || `.data/${role === 'payer' ? 'wallet' : 'payee'}`);
  const cfg = walletConfigFromEnv({ ...process.env, WALLET_BACKEND: 'wdk-rgb', [dataDirVar]: dataDir }, { dataDirVar });
  const fresh = !fs.existsSync(path.join(cfg.dataDir, 'mnemonic'));
  const w = new WdkRgbWallet(cfg);
  await w.init();
  log(role, `network ${cfg.network} · indexer ${cfg.indexerUrl} · data ${path.relative(repoRoot, cfg.dataDir)}`);
  if (fresh) log(role, `NEW wallet created (mnemonic saved in ${path.relative(repoRoot, cfg.dataDir)}/mnemonic, mode 600)`);
  return w;
}

export function log(role: string, msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${role.padEnd(5)} ${msg}`);
}

export function tokens(baseUnits: string, precision = 6): string {
  const s = baseUnits.padStart(precision + 1, '0');
  return `${s.slice(0, -precision)}.${s.slice(-precision)}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asset ID file written by issue-asset.ts (git-ignored). */
export const assetFile = path.join(repoRoot, '.data/tusdt.json');

export function readAssetId(): string | undefined {
  if (process.env.TUSDT_ASSET_ID) return process.env.TUSDT_ASSET_ID;
  if (!fs.existsSync(assetFile)) return undefined;
  return (JSON.parse(fs.readFileSync(assetFile, 'utf8')) as { assetId?: string }).assetId;
}

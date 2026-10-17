// pnpm demo:reset — back to demo-ready in one command: wipes the app's own data (.data/app.db with its invoices,
// plans, jobs, labels and receive requests; uploads; old demo files), keeps the wallets and their seeds, then runs
// demo:prepare (fresh RGB invoices, PDFs, funds check). The server must be stopped: it holds the DB and the wallet.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lockWalletDir, unlockWalletDir, WalletInUse } from '../src/lock.js';
import { loadDotEnv, log, repoRoot } from './common.js';

const t0 = Date.now();
loadDotEnv();
const dataBase = process.env.RGB_NETWORK === 'regtest' ? '.data/regtest' : '.data';
const payerDir = path.resolve(repoRoot, process.env.WALLET_DATA_DIR || `${dataBase}/wallet`);

// A running server holds the payer wallet's lock: refuse instead of wiping a DB in use.
try {
  lockWalletDir(payerDir);
  unlockWalletDir(payerDir);
} catch (e) {
  if (e instanceof WalletInUse) {
    console.error(
      `demo:reset: the app is still running (process ${e.pid} holds the wallet). Stop \`pnpm dev\` first, then run it again.`,
    );
    process.exit(1);
  }
  throw e;
}

const dbPath = path.resolve(repoRoot, process.env.DB_PATH || '.data/app.db');
const targets = [
  dbPath,
  `${dbPath}-wal`,
  `${dbPath}-shm`,
  path.resolve(repoRoot, process.env.UPLOAD_DIR || '.data/uploads'),
  path.join(repoRoot, '.data/demo'),
];
for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  fs.rmSync(t, { recursive: true, force: true });
  log('reset', `removed ${path.relative(repoRoot, t)}`);
}
log('reset', 'kept the wallets and their seeds; running demo:prepare');

const prep = spawnSync('pnpm', ['exec', 'tsx', 'scripts/demo-prepare.ts'], {
  cwd: path.join(repoRoot, 'packages/wallet'),
  stdio: 'inherit',
});
const secs = Math.round((Date.now() - t0) / 1000);
if (prep.status !== 0) {
  console.error(
    `demo:reset: the app data is clean, but demo:prepare reported problems (${secs} s). Fix them and rerun.`,
  );
  process.exit(prep.status ?? 1);
}
log('reset', `demo-ready in ${secs} s. Start \`pnpm dev\` (and \`pnpm -F wallet payee watch\`).`);

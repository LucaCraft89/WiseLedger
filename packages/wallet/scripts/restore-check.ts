// Restore drill: restores the payer wallet into CLEAN temporary folders and compares with the original.
//   1. words only            → the bitcoin balance comes back (RGB state is not in the words)
//   2. words + backup file   → the RGB asset balances come back too
// The words are never printed; the temporary folders are deleted at the end (--keep to inspect them).
// Usage: pnpm -F wallet restore-check [--keep]   (add RGB_NETWORK=regtest for the local chain)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WdkRgbWallet } from '../src/backend/wdk-rgb.js';
import { backupWallet, restoreWallet } from '../src/backup.js';
import { readSeed } from '../src/seed.js';
import { log, openWallet } from './common.js';

const keep = process.argv.includes('--keep');
const PASS = `drill-${Date.now()}`;

async function snapshot(w: WdkRgbWallet) {
  await w.sync();
  const btc = w.btcBalance();
  const sats = btc.vanilla.settled + btc.colored.settled;
  const assets = (await w.listAssets()).map((a) => `${a.ticker || a.assetId.slice(0, 14)} ${a.balance.settled}`);
  return { sats, assets: assets.sort().join(', ') || '(none)' };
}

const src = await openWallet('payer');
const cfg = src.config;
const before = await snapshot(src);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wiseledger-restore-'));
const backupFile = backupWallet(src, { passphrase: PASS, dir: path.join(work, 'backup') });
const words = readSeed(cfg.dataDir, cfg.seedPassphrase);
src.close();
log('drill', `original   · ${before.sats} sats · ${before.assets}`);

const rows: [string, boolean][] = [];
try {
  const onlyWords = await restoreWallet({ cfg: { ...cfg, dataDir: path.join(work, 'words-only') }, mnemonic: words });
  await onlyWords.init();
  const a = await snapshot(onlyWords);
  onlyWords.close();
  log('drill', `words only · ${a.sats} sats · ${a.assets}   (clean folder ${path.join(work, 'words-only')})`);
  rows.push(['bitcoin back from the 12 words', a.sats === before.sats]);

  const full = await restoreWallet({
    cfg: { ...cfg, dataDir: path.join(work, 'full') },
    mnemonic: words,
    backupFile,
    passphrase: PASS,
  });
  await full.init();
  const b = await snapshot(full);
  full.close();
  log('drill', `words+file · ${b.sats} sats · ${b.assets}   (clean folder ${path.join(work, 'full')})`);
  rows.push(['RGB assets back from words + backup file', b.assets === before.assets]);
} finally {
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
}
for (const [what, ok] of rows) log('drill', `${ok ? 'PASS' : 'FAIL'}  ${what}`);
process.exit(rows.every(([, ok]) => ok) ? 0 : 1);

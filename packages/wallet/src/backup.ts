// Seed backup and restore. RGB state (allocations, consignments) is NOT derivable from the mnemonic: a full restore
// needs the mnemonic AND an rgb-lib backup file (encrypted with a passphrase). Mnemonic alone restores bitcoin only.
import fs from 'node:fs';
import path from 'node:path';
import WDK from '@tetherto/wdk';
import WalletManagerRgb from '@utexo/wdk-wallet-rgb';
import { WdkRgbWallet } from './backend/wdk-rgb.js';
import { libNetwork, type WalletConfig } from './config.js';

const MIN_PASSPHRASE = 8;

function checkPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE)
    throw new Error(`The backup passphrase must be at least ${MIN_PASSPHRASE} characters.`);
}

/** Writes an encrypted rgb-lib backup into `dir` (0700) and returns the file path (timestamped copy). */
export function backupWallet(wallet: WdkRgbWallet, opts: { passphrase: string; dir: string }): string {
  checkPassphrase(opts.passphrase);
  fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const { backupPath } = wallet.rgb.createBackup({ backupPath: opts.dir, password: opts.passphrase });
  const stamped = backupPath.replace(/\.backup$/, `-${new Date().toISOString().replace(/[:.]/g, '-')}.backup`);
  fs.renameSync(backupPath, stamped);
  fs.chmodSync(stamped, 0o600);
  return stamped;
}

/**
 * Restores a wallet into a FRESH data dir (missing or empty) from the mnemonic, plus the rgb-lib backup file when
 * given (otherwise only bitcoin comes back). Returns a wallet to init(); the seed is stored at `<dataDir>/mnemonic`.
 */
export async function restoreWallet(opts: {
  cfg: WalletConfig;
  mnemonic: string;
  backupFile?: string;
  passphrase?: string;
}): Promise<WdkRgbWallet> {
  const mnemonic = opts.mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  if (!WDK.isValidSeed(mnemonic)) throw new Error('These words are not a valid recovery phrase.');
  const { dataDir } = opts.cfg;
  if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0)
    throw new Error(`Restore needs an empty folder; ${dataDir} already holds a wallet.`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (opts.backupFile) {
    checkPassphrase(opts.passphrase ?? '');
    if (!fs.existsSync(opts.backupFile)) throw new Error(`Backup file not found: ${opts.backupFile}`);
    const manager = new WalletManagerRgb(mnemonic, {
      network: libNetwork(opts.cfg.network),
      dataDir,
      indexerUrl: opts.cfg.indexerUrl,
      transportEndpoint: opts.cfg.transportEndpoint,
    } as never);
    // Unpacks the encrypted rgb-lib backup into dataDir (wrong passphrase → throws, nothing written).
    await manager.restoreAccountFromBackup({
      backupFilePath: path.resolve(opts.backupFile),
      password: opts.passphrase,
      dataDir,
    } as never);
  }
  fs.writeFileSync(path.join(dataDir, 'mnemonic'), `${mnemonic}\n`, { mode: 0o600, flag: 'wx' });
  return new WdkRgbWallet(opts.cfg);
}

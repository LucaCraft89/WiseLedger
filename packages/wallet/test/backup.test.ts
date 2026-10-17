// Seed backup and restore. Refusals run always; the full round trip runs on local regtest with LIVE_WALLET=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WDK from '@tetherto/wdk';
import { describe, expect, it } from 'vitest';
import { WdkRgbWallet } from '../src/backend/wdk-rgb.js';
import { backupWallet, restoreWallet } from '../src/backup.js';
import { walletConfigFromEnv } from '../src/config.js';

const root = path.resolve(import.meta.dirname, '../../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wl-restore-'));
const cfgFor = (dir: string) => walletConfigFromEnv({ RGB_NETWORK: 'regtest', WALLET_DATA_DIR: dir });

describe('restoreWallet refusals', () => {
  it('refuses words that are not a recovery phrase', async () => {
    await expect(restoreWallet({ cfg: cfgFor(path.join(tmp(), 'w')), mnemonic: 'hello world' })).rejects.toThrow(
      /not a valid recovery phrase/,
    );
  });

  it('refuses a folder that already holds a wallet', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mnemonic'), 'x');
    await expect(restoreWallet({ cfg: cfgFor(dir), mnemonic: WDK.getRandomSeedPhrase(12) })).rejects.toThrow(
      /empty folder/,
    );
  });

  it('refuses a short passphrase with a backup file', async () => {
    await expect(
      restoreWallet({
        cfg: cfgFor(path.join(tmp(), 'w')),
        mnemonic: WDK.getRandomSeedPhrase(12),
        backupFile: '/nonexistent',
        passphrase: 'short',
      }),
    ).rejects.toThrow(/at least 8/);
  });

  it('mnemonic only: stores the seed (0600) in the fresh folder', async () => {
    const dir = path.join(tmp(), 'w');
    const words = WDK.getRandomSeedPhrase(12);
    const w = await restoreWallet({ cfg: cfgFor(dir), mnemonic: `  ${words.toUpperCase()} ` });
    expect(w).toBeInstanceOf(WdkRgbWallet);
    expect(fs.readFileSync(path.join(dir, 'mnemonic'), 'utf8').trim()).toBe(words);
    expect(fs.statSync(path.join(dir, 'mnemonic')).mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(process.env.LIVE_WALLET !== '1')('backup → restore round trip (regtest)', () => {
  it('restores TUSDT balances from mnemonic + encrypted backup into a clean folder', async () => {
    const src = new WdkRgbWallet(cfgFor(path.join(root, '.data/regtest/wallet')));
    await src.init();
    await src.sync();
    const before = await src.listAssets();
    const file = backupWallet(src, { passphrase: 'correct horse battery', dir: tmp() });
    expect(fs.existsSync(file)).toBe(true);
    src.close();

    const mnemonic = fs.readFileSync(path.join(root, '.data/regtest/wallet/mnemonic'), 'utf8');
    const target = path.join(tmp(), 'restored');
    await expect(
      restoreWallet({
        cfg: cfgFor(path.join(tmp(), 'bad')),
        mnemonic,
        backupFile: file,
        passphrase: 'wrong passphrase',
      }),
    ).rejects.toThrow();
    const restored = await restoreWallet({
      cfg: cfgFor(target),
      mnemonic,
      backupFile: file,
      passphrase: 'correct horse battery',
    });
    await restored.init();
    await restored.sync();
    const after = await restored.listAssets();
    expect(after.map((a) => [a.assetId, a.balance.settled])).toEqual(before.map((a) => [a.assetId, a.balance.settled]));
    restored.close();
  }, 120_000);
});

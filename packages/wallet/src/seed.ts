// Mnemonic storage: `<dataDir>/mnemonic`, directory 0700, file 0600, never logged, never committed (.data/ is git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import WDK from '@tetherto/wdk';

export interface LoadedSeed {
  mnemonic: string;
  created: boolean;
}

export function loadOrCreateMnemonic(dataDir: string): LoadedSeed {
  const file = path.join(dataDir, 'mnemonic');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const mnemonic = fs.readFileSync(file, 'utf8').trim();
    if (!WDK.isValidSeed(mnemonic)) throw new Error(`The mnemonic in ${file} is not a valid BIP-39 phrase.`);
    return { mnemonic, created: false };
  }
  const mnemonic = WDK.getRandomSeedPhrase(12);
  fs.writeFileSync(file, `${mnemonic}\n`, { mode: 0o600, flag: 'wx' });
  return { mnemonic, created: true };
}

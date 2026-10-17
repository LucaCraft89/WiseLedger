// Mnemonic storage in `<dataDir>` (0700), never logged, never committed (.data/ is git-ignored). Two forms:
//  - `mnemonic`      plain text, mode 0600 (default)
//  - `mnemonic.enc`  optional wallet lock: AES-256-GCM, key from the passphrase via scrypt; the plain file is removed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WDK from '@tetherto/wdk';
import { WalletLocked } from 'core';

export interface LoadedSeed {
  mnemonic: string;
  created: boolean;
}

export type SeedStatus = 'none' | 'plain' | 'locked';

const PLAIN = 'mnemonic';
const LOCKED = 'mnemonic.enc';
export const MIN_WALLET_PASSPHRASE = 8;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface LockedFile {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export function seedStatus(dataDir: string): SeedStatus {
  if (fs.existsSync(path.join(dataDir, LOCKED))) return 'locked';
  if (fs.existsSync(path.join(dataDir, PLAIN))) return 'plain';
  return 'none';
}

/** Lowercases and collapses whitespace; throws when the words are not a valid BIP-39 phrase. */
export function normalizeMnemonic(words: string): string {
  const mnemonic = words.trim().toLowerCase().split(/\s+/).join(' ');
  if (!WDK.isValidSeed(mnemonic)) throw new Error('These words are not a valid recovery phrase.');
  return mnemonic;
}

function checkPassphrase(passphrase: string): void {
  if (passphrase.length < MIN_WALLET_PASSPHRASE)
    throw new Error(`The wallet passphrase must be at least ${MIN_WALLET_PASSPHRASE} characters.`);
}

function key(passphrase: string, salt: Buffer, N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, 32, { N, r, p, maxmem: SCRYPT.maxmem });
}

function encrypt(mnemonic: string, passphrase: string): LockedFile {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  const ct = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  const b64 = (b: Buffer) => b.toString('base64');
  return {
    v: 1,
    kdf: 'scrypt',
    ...{ N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    salt: b64(salt),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    ct: b64(ct),
  };
}

function decrypt(file: LockedFile, passphrase: string): string {
  const b = (s: string) => Buffer.from(s, 'base64');
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key(passphrase, b(file.salt), file.N, file.r, file.p),
      b(file.iv),
    );
    decipher.setAuthTag(b(file.tag));
    return Buffer.concat([decipher.update(b(file.ct)), decipher.final()]).toString('utf8');
  } catch {
    throw new WalletLocked('Wrong wallet passphrase.');
  }
}

/** Writes a new seed file; `passphrase` stores it locked. Fails if any seed file already exists. */
export function writeSeed(dataDir: string, mnemonic: string, passphrase?: string): void {
  if (seedStatus(dataDir) !== 'none') throw new Error(`${dataDir} already holds a wallet seed.`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (passphrase === undefined) {
    fs.writeFileSync(path.join(dataDir, PLAIN), `${mnemonic}\n`, { mode: 0o600, flag: 'wx' });
    return;
  }
  checkPassphrase(passphrase);
  fs.writeFileSync(path.join(dataDir, LOCKED), JSON.stringify(encrypt(mnemonic, passphrase)), {
    mode: 0o600,
    flag: 'wx',
  });
}

/** Reads the seed; a locked seed needs the passphrase (WalletLocked when missing or wrong). */
export function readSeed(dataDir: string, passphrase?: string): string {
  const status = seedStatus(dataDir);
  if (status === 'none') throw new Error(`No wallet seed in ${dataDir}.`);
  let mnemonic: string;
  if (status === 'locked') {
    if (!passphrase) throw new WalletLocked();
    mnemonic = decrypt(JSON.parse(fs.readFileSync(path.join(dataDir, LOCKED), 'utf8')) as LockedFile, passphrase);
  } else {
    mnemonic = fs.readFileSync(path.join(dataDir, PLAIN), 'utf8').trim();
  }
  if (!WDK.isValidSeed(mnemonic)) throw new Error(`The wallet seed in ${dataDir} is not a valid BIP-39 phrase.`);
  return mnemonic;
}

/** Opens the seed, creating a new 12-word one (locked when a passphrase is given) when the folder has none. */
export function loadOrCreateMnemonic(dataDir: string, opts: { passphrase?: string } = {}): LoadedSeed {
  if (seedStatus(dataDir) !== 'none') return { mnemonic: readSeed(dataDir, opts.passphrase), created: false };
  const mnemonic = WDK.getRandomSeedPhrase(12);
  writeSeed(dataDir, mnemonic, opts.passphrase);
  return { mnemonic, created: true };
}

/** Turns on the wallet lock: encrypts the plain seed and removes the plain file (overwritten first). */
export function lockSeed(dataDir: string, passphrase: string): void {
  checkPassphrase(passphrase);
  if (seedStatus(dataDir) !== 'plain') throw new Error('Only an unlocked wallet seed can be locked.');
  const plain = path.join(dataDir, PLAIN);
  const mnemonic = readSeed(dataDir);
  const tmp = path.join(dataDir, `${LOCKED}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(encrypt(mnemonic, passphrase)), { mode: 0o600 });
  if (readSeedFile(tmp, passphrase) !== mnemonic) throw new Error('Could not verify the locked seed; nothing changed.');
  fs.renameSync(tmp, path.join(dataDir, LOCKED));
  fs.writeFileSync(plain, ' '.repeat(mnemonic.length + 1));
  fs.rmSync(plain);
}

function readSeedFile(file: string, passphrase: string): string {
  return decrypt(JSON.parse(fs.readFileSync(file, 'utf8')) as LockedFile, passphrase);
}

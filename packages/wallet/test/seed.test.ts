// Wallet lock: seed encrypted at rest. Pure file + crypto tests (no chain, no native code).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WDK from '@tetherto/wdk';
import { WalletLocked } from 'core';
import { describe, expect, it } from 'vitest';
import { loadOrCreateMnemonic, lockSeed, normalizeMnemonic, readSeed, seedStatus, writeSeed } from '../src/seed.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wl-seed-'));
const PASS = 'correct horse battery';

describe('seed storage and wallet lock', () => {
  it('creates a plain 12-word seed (0600) in a fresh folder, then reads the same one back', () => {
    const dir = tmp();
    expect(seedStatus(dir)).toBe('none');
    const a = loadOrCreateMnemonic(dir);
    expect(a.created).toBe(true);
    expect(a.mnemonic.split(' ')).toHaveLength(12);
    expect(fs.statSync(path.join(dir, 'mnemonic')).mode & 0o777).toBe(0o600);
    expect(loadOrCreateMnemonic(dir)).toEqual({ mnemonic: a.mnemonic, created: false });
  });

  it('creates a locked seed when a passphrase is given; no plain words on disk', { timeout: 30_000 }, () => {
    const dir = tmp();
    const { mnemonic } = loadOrCreateMnemonic(dir, { passphrase: PASS });
    expect(seedStatus(dir)).toBe('locked');
    expect(fs.existsSync(path.join(dir, 'mnemonic'))).toBe(false);
    const raw = fs.readFileSync(path.join(dir, 'mnemonic.enc'), 'utf8');
    for (const word of mnemonic.split(' ')) expect(raw).not.toContain(` ${word} `);
    expect(readSeed(dir, PASS)).toBe(mnemonic);
  });

  it('a locked seed needs the right passphrase (WalletLocked otherwise)', { timeout: 30_000 }, () => {
    const dir = tmp();
    loadOrCreateMnemonic(dir, { passphrase: PASS });
    expect(() => readSeed(dir)).toThrow(WalletLocked);
    expect(() => readSeed(dir, 'wrong passphrase')).toThrow(/Wrong wallet passphrase/);
    expect(() => loadOrCreateMnemonic(dir)).toThrow(WalletLocked);
  });

  // scrypt key derivation takes several seconds on a loaded machine (vitest's default timeout is 5 s).
  it('lockSeed turns an existing plain seed into a locked one and removes the plain file', { timeout: 30_000 }, () => {
    const dir = tmp();
    const { mnemonic } = loadOrCreateMnemonic(dir);
    lockSeed(dir, PASS);
    expect(seedStatus(dir)).toBe('locked');
    expect(fs.existsSync(path.join(dir, 'mnemonic'))).toBe(false);
    expect(readSeed(dir, PASS)).toBe(mnemonic);
    expect(() => lockSeed(dir, PASS)).toThrow(/Only an unlocked/);
  });

  it('refuses short passphrases and a second seed in the same folder', () => {
    const dir = tmp();
    expect(() => loadOrCreateMnemonic(dir, { passphrase: 'short' })).toThrow(/at least 8/);
    const words = WDK.getRandomSeedPhrase(12);
    writeSeed(dir, words);
    expect(() => writeSeed(dir, words, PASS)).toThrow(/already holds/);
  });

  it('normalizes typed words and rejects a non-phrase', () => {
    const words = WDK.getRandomSeedPhrase(12);
    expect(normalizeMnemonic(`  ${words.toUpperCase().split(' ').join('   ')}\n`)).toBe(words);
    expect(() => normalizeMnemonic('one two three')).toThrow(/not a valid recovery phrase/);
  });
});

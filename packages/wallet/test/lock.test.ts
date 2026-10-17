// One wallet folder, one process: a live other holder is refused, a dead one's lock is taken over.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockWalletDir, unlockWalletDir, WalletInUse } from '../src/lock.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-lock-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    unlockWalletDir(d);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('wallet folder lock', () => {
  it('is idempotent in one process and released on unlock', () => {
    const d = tmp();
    lockWalletDir(d);
    lockWalletDir(d);
    expect(fs.readFileSync(path.join(d, '.wiseledger.lock'), 'utf8')).toBe(String(process.pid));
    unlockWalletDir(d);
    expect(fs.existsSync(path.join(d, '.wiseledger.lock'))).toBe(false);
  });

  it('refuses a folder held by another live process', async () => {
    const d = tmp();
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    try {
      fs.writeFileSync(path.join(d, '.wiseledger.lock'), String(other.pid));
      expect(() => lockWalletDir(d)).toThrow(WalletInUse);
    } finally {
      other.kill();
    }
  });

  it('takes over the lock of a process that is gone', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.wiseledger.lock'), '999999999');
    lockWalletDir(d);
    expect(fs.readFileSync(path.join(d, '.wiseledger.lock'), 'utf8')).toBe(String(process.pid));
  });
});

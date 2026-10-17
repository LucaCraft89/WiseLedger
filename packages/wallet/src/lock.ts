// One wallet = one data dir = one process. rgb-lib does not lock its folder: two processes on the same wallet (e.g. two
// `payee watch`, or demo:prepare while the server runs) corrupt its chain cache. A pid file makes the second one stop.
import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILE = '.wiseledger.lock';
const held = new Set<string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class WalletInUse extends Error {
  constructor(
    readonly dataDir: string,
    readonly pid: number,
  ) {
    super(
      `This wallet (${dataDir}) is already open in another program (process ${pid}). Stop that program first ` +
        '(for example the server, or another `payee watch`): two programs on one wallet can damage it.',
    );
    this.name = 'WalletInUse';
  }
}

/** Takes the folder's lock for this process (idempotent); a lock left by a dead process is taken over. */
export function lockWalletDir(dataDir: string): void {
  const dir = path.resolve(dataDir);
  if (held.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      held.add(dir);
      process.once('exit', () => unlockWalletDir(dir));
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (pid === process.pid) {
        held.add(dir);
        return;
      }
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new WalletInUse(dir, pid);
      fs.rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  throw new WalletInUse(dir, Number.NaN);
}

/** Releases the lock if this process holds it. */
export function unlockWalletDir(dataDir: string): void {
  const dir = path.resolve(dataDir);
  if (!held.delete(dir)) return;
  const file = path.join(dir, LOCK_FILE);
  try {
    if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // already gone
  }
}

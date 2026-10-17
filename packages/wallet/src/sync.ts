// Background wallet sync: every `intervalMs` (default 15 s); on failure back off (×2 up to `maxMs`), reset on success.
// Sync only refreshes and reads chain state, so retrying it is safe (sends are never retried anywhere).
// rgb-lib's sync is a blocking native call (1–5 s on Mutinynet) that freezes the server while it runs, so with
// `idleIntervalMs` + `isBusy` the loop syncs fast only while something is in flight and slowly otherwise.
import type { WalletPort } from 'core';

export interface SyncLoopOptions {
  intervalMs?: number;
  maxMs?: number;
  onSynced?: () => void;
  onError?: (err: unknown, nextDelayMs: number) => void;
  /** Interval while nothing is in flight (isBusy() false). Default: intervalMs (always fast). */
  idleIntervalMs?: number;
  /** True while a payment or a receive is pending, so the next sync comes after intervalMs. Errors count as busy. */
  isBusy?: () => boolean | Promise<boolean>;
}

export interface SyncLoop {
  stop(): void;
  /** Sync now (e.g. after a payment), then continue the normal cadence. */
  kick(): Promise<void>;
  readonly lastSyncAt: Date | null;
  readonly lastError: string | null;
}

export function startSyncLoop(wallet: Pick<WalletPort, 'sync'>, opts: SyncLoopOptions = {}): SyncLoop {
  const base = opts.intervalMs ?? 15_000;
  const max = opts.maxMs ?? 5 * 60_000;
  let delay = base;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  const state = { lastSyncAt: null as Date | null, lastError: null as string | null };

  const idle = opts.idleIntervalMs ?? base;
  const busy = async (): Promise<boolean> => {
    if (!opts.isBusy || idle === base) return true;
    try {
      return await opts.isBusy();
    } catch {
      return true;
    }
  };

  const run = (): Promise<void> => {
    running ??= (async () => {
      try {
        await wallet.sync();
        state.lastSyncAt = new Date();
        state.lastError = null;
        delay = (await busy()) ? base : idle;
        opts.onSynced?.();
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        delay = Math.min(delay * 2, max);
        opts.onError?.(err, delay);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer); // never two timers (a kick may re-arm while the timer's own sync runs)
    timer = setTimeout(async () => {
      await run();
      schedule();
    }, delay);
    timer.unref?.();
  };
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    async kick() {
      await run();
      schedule(); // re-arm at the new pace: a payment just sent must not wait out an idle interval
    },
    get lastSyncAt() {
      return state.lastSyncAt;
    },
    get lastError() {
      return state.lastError;
    },
  };
}

// Background wallet sync: every `intervalMs` (default 15 s); on failure back off (×2 up to `maxMs`), reset on success.
// Sync only refreshes and reads chain state, so retrying it is safe (sends are never retried anywhere).
import type { WalletPort } from 'core';

export interface SyncLoopOptions {
  intervalMs?: number;
  maxMs?: number;
  onSynced?: () => void;
  onError?: (err: unknown, nextDelayMs: number) => void;
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

  const run = (): Promise<void> => {
    running ??= (async () => {
      try {
        await wallet.sync();
        state.lastSyncAt = new Date();
        state.lastError = null;
        delay = base;
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
    },
    get lastSyncAt() {
      return state.lastSyncAt;
    },
    get lastError() {
      return state.lastError;
    },
  };
}

// Retry with backoff for READS that reach the indexer or the proxy (sync, refresh). Never wrap a send with this:
// after a send timeout the rule is sync-and-check, not resend (AGENTS.md, a-002).
import { NetworkUnavailable } from 'core';

/** Errors that mean "the network service did not answer", as rgb-lib, electrum and fetch phrase them. */
const TRANSIENT =
  /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|Indexer|Electrum|esplora|Proxy|connection (refused|reset|closed)|503|502|504|Too Many Requests|429/i;

export function isTransientNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return TRANSIENT.test(msg);
}

export interface ReadRetryOptions {
  /** Total tries including the first (default 3). */
  attempts?: number;
  /** First wait in ms, doubled each time up to maxMs (default 500 → 4000). */
  baseMs?: number;
  maxMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs a read; on a transient network error waits and tries again. After the last try throws NetworkUnavailable
 * (cause = the last error). Non-network errors are rethrown at once, unchanged.
 */
export async function withReadRetry<T>(op: () => T | Promise<T>, opts: ReadRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const max = opts.maxMs ?? 4_000;
  const sleep = opts.sleep ?? wait;
  let delay = opts.baseMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      if (!isTransientNetworkError(e)) throw e;
      if (attempt >= attempts) {
        const err = new NetworkUnavailable();
        (err as { cause?: unknown }).cause = e;
        throw err;
      }
      opts.onRetry?.(e, attempt, delay);
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }
}

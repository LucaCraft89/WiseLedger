// Retry with backoff on network reads only; the backend sync uses it (fake account, no chain).
import { NetworkUnavailable } from 'core';
import { describe, expect, it, vi } from 'vitest';
import { type RgbAccount, WdkRgbWallet } from '../src/backend/wdk-rgb.js';
import { walletConfigFromEnv } from '../src/config.js';
import { isTransientNetworkError, withReadRetry } from '../src/retry.js';

const noSleep = { sleep: async () => {} };

describe('withReadRetry', () => {
  it('retries a transient network error with doubling waits, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const r = await withReadRetry(
      () => {
        if (++calls < 3) throw new Error('connect ECONNREFUSED 127.0.0.1:50001');
        return 'ok';
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(r).toBe('ok');
    expect(waits).toEqual([500, 1000]);
  });

  it('after the last try throws NetworkUnavailable with plain words and the cause', async () => {
    const op = vi.fn(() => {
      throw new Error('Indexer error: request timed out');
    });
    const err = await withReadRetry(op, { ...noSleep, attempts: 4 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkUnavailable);
    expect((err as Error).message).toMatch(/Nothing was sent/);
    expect((err as { cause?: Error }).cause?.message).toMatch(/timed out/);
    expect(op).toHaveBeenCalledTimes(4);
  });

  it('does not retry other errors', async () => {
    const op = vi.fn(() => {
      throw new Error('AssetNotFound');
    });
    await expect(withReadRetry(op, noSleep)).rejects.toThrow('AssetNotFound');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('classifies network errors', () => {
    for (const m of ['socket hang up', 'fetch failed', 'getaddrinfo EAI_AGAIN esplora', 'HTTP 503']) {
      expect(isTransientNetworkError(new Error(m))).toBe(true);
    }
    expect(isTransientNetworkError(new Error('InsufficientSpendableAssets'))).toBe(false);
  });
});

describe('WdkRgbWallet.sync with a flaky indexer', () => {
  function wallet(sdk: Record<string, unknown>) {
    const account = { getRgbWallet: () => sdk } as unknown as RgbAccount;
    const cfg = walletConfigFromEnv({ RGB_NETWORK: 'regtest', WALLET_DATA_DIR: '/nonexistent' });
    return new WdkRgbWallet(cfg, { account, retry: noSleep });
  }

  it('retries refresh and sync until the indexer answers', async () => {
    let fails = 2;
    const sdk = {
      refreshWallet: vi.fn(),
      syncWallet: vi.fn(() => {
        if (fails-- > 0) throw new Error('Electrum error: connection refused');
      }),
    };
    await wallet(sdk).sync();
    expect(sdk.syncWallet).toHaveBeenCalledTimes(3);
  });

  it('a dead proxy still lets the indexer sync run, then reports NetworkUnavailable', async () => {
    const sdk = {
      refreshWallet: vi.fn(() => {
        throw new Error('Proxy error: 502 Bad Gateway');
      }),
      syncWallet: vi.fn(),
    };
    await expect(wallet(sdk).sync()).rejects.toBeInstanceOf(NetworkUnavailable);
    expect(sdk.refreshWallet).toHaveBeenCalledTimes(3);
    expect(sdk.syncWallet).toHaveBeenCalledTimes(1);
  });
});

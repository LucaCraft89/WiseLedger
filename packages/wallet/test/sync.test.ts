import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSyncLoop } from '../src/sync.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startSyncLoop', () => {
  it('syncs on the interval and backs off on errors, resetting after success', async () => {
    vi.useFakeTimers();
    let fail = 2;
    const sync = vi.fn(async () => {
      if (fail-- > 0) throw new Error('indexer down');
    });
    const delays: number[] = [];
    const loop = startSyncLoop({ sync }, { intervalMs: 1000, onError: (_e, d) => delays.push(d) });
    await vi.advanceTimersByTimeAsync(1000); // fail → 2000
    await vi.advanceTimersByTimeAsync(2000); // fail → 4000
    await vi.advanceTimersByTimeAsync(4000); // ok → back to 1000
    await vi.advanceTimersByTimeAsync(1000); // ok
    expect(delays).toEqual([2000, 4000]);
    expect(sync).toHaveBeenCalledTimes(4);
    expect(loop.lastError).toBeNull();
    expect(loop.lastSyncAt).not.toBeNull();
    loop.stop();
  });

  it('kick() syncs immediately and never overlaps a running sync', async () => {
    let resolve: () => void = () => {};
    const sync = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const loop = startSyncLoop({ sync }, { intervalMs: 60_000 });
    const a = loop.kick();
    const b = loop.kick();
    resolve();
    await Promise.all([a, b]);
    expect(sync).toHaveBeenCalledTimes(1);
    loop.stop();
  });
});

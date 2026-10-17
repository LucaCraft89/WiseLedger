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

  it('syncs fast while busy, slowly when idle; kick() re-arms at the fast pace', async () => {
    vi.useFakeTimers();
    let pending = false;
    const sync = vi.fn(async () => undefined);
    const loop = startSyncLoop({ sync }, { intervalMs: 1000, idleIntervalMs: 10_000, isBusy: () => pending });
    await vi.advanceTimersByTimeAsync(1000); // first sync; idle → next in 10 s
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(sync).toHaveBeenCalledTimes(1);
    pending = true; // a payment goes out and the app kicks
    await loop.kick();
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); // busy → 1 s, not the old idle timer
    expect(sync).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync).toHaveBeenCalledTimes(4);
    pending = false;
    await vi.advanceTimersByTimeAsync(1000); // settles; now idle
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync).toHaveBeenCalledTimes(5);
    loop.stop();
  });

  it('a failing isBusy counts as busy (fast)', async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => undefined);
    const loop = startSyncLoop(
      { sync },
      {
        intervalMs: 1000,
        idleIntervalMs: 10_000,
        isBusy: () => {
          throw new Error('x');
        },
      },
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).toHaveBeenCalledTimes(2);
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

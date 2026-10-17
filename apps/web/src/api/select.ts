import { type ApiClient, createHttpClient } from './client.js';
import type { OnboardingState } from './contracts.js';
import { createFakeClient } from './fake.js';

/** VITE_FAKE_ONBOARDING=needs_setup|locked shows the first-run screens in demo mode (default: ready). */
function fakeOnboarding(): OnboardingState | undefined {
  const v = import.meta.env.VITE_FAKE_ONBOARDING;
  return v === 'needs_setup' || v === 'locked' ? v : undefined;
}

/** The in-browser demo backend: only when asked for (VITE_FAKE_API=1 or the "demo without a server" button). */
export const demoClient = (): ApiClient => createFakeClient({ onboarding: fakeOnboarding() });
export const demoRequested = (): boolean => import.meta.env.VITE_FAKE_API === '1';

/**
 * The real server, retried until it answers: never a silent switch to the demo backend, which would look normal
 * while nothing is real. `onWaiting(attempt)` lets the screen say "Server not reachable, retrying…".
 */
export async function connectServer(
  onWaiting: (attempt: number) => void,
  opts: { signal?: AbortSignal; delayMs?: (attempt: number) => number } = {},
): Promise<ApiClient> {
  const http = createHttpClient();
  const delay = opts.delayMs ?? ((n: number) => Math.min(1000 * n, 5000));
  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted');
    try {
      await http.health();
      return http;
    } catch {
      onWaiting(attempt);
      await new Promise((r) => setTimeout(r, delay(attempt)));
    }
  }
}

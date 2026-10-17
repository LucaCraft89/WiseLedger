import { type ApiClient, createHttpClient } from './client.js';
import type { OnboardingState } from './contracts.js';
import { createFakeClient } from './fake.js';

/** VITE_FAKE_ONBOARDING=needs_setup|locked shows the first-run screens in demo mode (default: ready). */
function fakeOnboarding(): OnboardingState | undefined {
  const v = import.meta.env.VITE_FAKE_ONBOARDING;
  return v === 'needs_setup' || v === 'locked' ? v : undefined;
}

/** VITE_FAKE_API=1 → in-browser fake. Otherwise the real server, falling back to the fake if /api/health fails. */
export async function selectClient(): Promise<ApiClient> {
  if (import.meta.env.VITE_FAKE_API === '1') return createFakeClient({ onboarding: fakeOnboarding() });
  const http = createHttpClient();
  try {
    await http.health();
    return http;
  } catch {
    return createFakeClient({ onboarding: fakeOnboarding() });
  }
}

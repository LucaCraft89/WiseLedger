import { type ApiClient, createHttpClient } from './client.js';
import { createFakeClient } from './fake.js';

/** VITE_FAKE_API=1 → in-browser fake. Otherwise the real server, falling back to the fake if /api/health fails. */
export async function selectClient(): Promise<ApiClient> {
  if (import.meta.env.VITE_FAKE_API === '1') return createFakeClient();
  const http = createHttpClient();
  try {
    await http.health();
    return http;
  } catch {
    return createFakeClient();
  }
}

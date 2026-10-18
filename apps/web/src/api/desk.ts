import { composeDesk } from '../lib/desk.js';
import type { ApiClient } from './client.js';
import type { DeskResponse } from './contracts.js';

/** The desk built from the routes that exist today (real data); the server's GET /api/desk replaces it. */
export async function deskFromApi(api: ApiClient): Promise<DeskResponse> {
  const [invoices, schedule, receives, transfers, wallet, health] = await Promise.all([
    api.listInvoices(),
    api.schedule().catch(() => ({ jobs: [] })),
    api.receives({ status: 'all', limit: 100 }).catch(() => ({ receives: [] })),
    api.transfers().catch(() => ({ transfers: [] })),
    api.wallet(),
    api.health().catch(() => null),
  ]);
  return composeDesk({
    invoices: invoices.invoices,
    jobs: schedule.jobs,
    receives: receives.receives,
    transfers: transfers.transfers,
    wallet,
    problems: health?.problems ?? [],
  });
}

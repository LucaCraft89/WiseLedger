// pnpm demo:mock — full invoice flow on mocks: upload → analysis → confirm → PAID.
// Starts the server in-process on a free port, or targets DEMO_URL when set. Exit 0 only on PAID within 30 s.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ConfirmResponse, CreateInvoiceResponse, InvoiceDetailResponse } from 'core';
import { startServer } from '../src/server.js';

const TIMEOUT_MS = 30_000;
const FIXTURE = fileURLToPath(new URL('./fixtures/ok-basic.txt', import.meta.url));
const deadline = Date.now() + TIMEOUT_MS;

let stop: (() => Promise<void>) | undefined;

async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  const body = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${body.error?.code}: ${body.error?.message}`);
  return body;
}

async function waitFor(base: string, id: string, until: string[], seen: Set<string>): Promise<InvoiceDetailResponse> {
  for (;;) {
    const detail = await api<InvoiceDetailResponse>(base, `/api/invoices/${id}`);
    for (const e of detail.events) {
      if (e.type === 'state' && !seen.has(e.to)) {
        seen.add(e.to);
        console.log(`  state: ${e.to}`);
      }
    }
    if (until.includes(detail.invoice.state)) return detail;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${TIMEOUT_MS / 1000} s in state ${detail.invoice.state}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main(): Promise<void> {
  let base = process.env.DEMO_URL?.replace(/\/$/, '');
  if (!base) {
    const started = await startServer({ port: 0, mockStepMs: Number(process.env.MOCK_STEP_MS ?? 500) });
    base = started.url;
    stop = () => started.app.close();
  }
  console.log(`WiseLedger demo (mocks) against ${base}`);

  const health = await api<{ ok: boolean }>(base, '/api/health');
  if (!health.ok) throw new Error('Server health is not ok');

  const form = new FormData();
  form.append('file', new Blob([await readFile(FIXTURE)], { type: 'text/plain' }), 'ok-basic.txt');
  const created = await api<CreateInvoiceResponse>(base, '/api/invoices', { method: 'POST', body: form });
  console.log(`Uploaded ok-basic.txt → invoice ${created.invoiceId}`);

  const seen = new Set<string>();
  const analysed = await waitFor(base, created.invoiceId, ['AWAITING_CONFIRMATION', 'BLOCKED', 'FAILED'], seen);
  if (analysed.invoice.state !== 'AWAITING_CONFIRMATION' || !analysed.plan) {
    throw new Error(`Analysis ended in ${analysed.invoice.state}, expected AWAITING_CONFIRMATION`);
  }
  console.log(`Verdict: ${analysed.report?.verdict}. ${analysed.confirmationSentence}`);

  const confirmed = await api<ConfirmResponse>(base, `/api/invoices/${created.invoiceId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: analysed.plan.planId }),
  });
  console.log(`Confirmed plan ${confirmed.planId.slice(0, 12)}…`);

  const final = await waitFor(base, created.invoiceId, ['PAID', 'FAILED', 'REJECTED', 'BLOCKED', 'SCHEDULED'], seen);
  if (final.invoice.state !== 'PAID') throw new Error(`Payment ended in ${final.invoice.state}, expected PAID`);
  console.log(`PAID · transfer ${final.execution?.transferId} · txid ${final.execution?.txid ?? 'n/a'}`);
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error(`Demo failed: ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
}
await stop?.();
process.exit(code);

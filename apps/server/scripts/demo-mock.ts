// pnpm demo:mock — invoice flow on mocks, three paths: ok → confirm → PAID; review → refused without override,
// PAID with it; block → BLOCKED and confirm refused. Starts the server in-process on a free port, or targets
// DEMO_URL when set. Exit 0 only when all three behave within 30 s.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CreateInvoiceResponse, InvoiceDetailResponse } from 'core';
import { startServer } from '../src/server.js';

const TIMEOUT_MS = 30_000;
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
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
    // Hermetic by default: a throwaway in-memory DB unless DB_PATH is set.
    const started = await startServer({
      port: 0,
      dbPath: process.env.DB_PATH ?? ':memory:',
      mockStepMs: Number(process.env.MOCK_STEP_MS ?? 500),
    });
    base = started.url;
    stop = () => started.app.close();
  }
  console.log(`WiseLedger demo (mocks) against ${base}`);

  const health = await api<{ ok: boolean }>(base, '/api/health');
  if (!health.ok) throw new Error('Server health is not ok');

  await scenario(base, 'ok-basic.txt', 'ok');
  await scenario(base, 'ok-eur.txt', 'review');
  await scenario(base, 'scam-bank-change.txt', 'block');
  console.log('All three paths behaved: ok → PAID, review → override → PAID, block → refused.');
}

async function confirm(base: string, id: string, planId: string, override?: boolean): Promise<Response> {
  return fetch(`${base}/api/invoices/${id}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId, ...(override === undefined ? {} : { override }) }),
  });
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code: string } }).error?.code;
}

async function scenario(base: string, file: string, expect: 'ok' | 'review' | 'block'): Promise<void> {
  console.log(`\n[${expect}] ${file}`);
  const form = new FormData();
  form.append('file', new Blob([await readFile(fixture(file))], { type: 'text/plain' }), file);
  const created = await api<CreateInvoiceResponse>(base, '/api/invoices', { method: 'POST', body: form });
  const id = created.invoiceId;
  const seen = new Set<string>();
  const analysed = await waitFor(base, id, ['AWAITING_CONFIRMATION', 'BLOCKED', 'FAILED'], seen);
  console.log(`  verdict: ${analysed.report?.verdict}`);
  if (analysed.report?.verdict !== expect)
    throw new Error(`${file}: verdict ${analysed.report?.verdict}, expected ${expect}`);

  if (expect === 'block') {
    if (analysed.invoice.state !== 'BLOCKED')
      throw new Error(`${file}: state ${analysed.invoice.state}, expected BLOCKED`);
    const res = await confirm(base, id, analysed.plan?.planId ?? 'none', true);
    if (res.ok) throw new Error(`${file}: confirm of a blocked invoice was accepted`);
    console.log(`  confirm refused: ${res.status} ${await errorCode(res)}`);
    return;
  }
  if (analysed.invoice.state !== 'AWAITING_CONFIRMATION' || !analysed.plan) {
    throw new Error(`${file}: analysis ended in ${analysed.invoice.state}, expected AWAITING_CONFIRMATION`);
  }
  console.log(`  ${analysed.confirmationSentence}`);
  if (expect === 'review') {
    const res = await confirm(base, id, analysed.plan.planId);
    if (res.ok) throw new Error(`${file}: review confirmed without override`);
    console.log(`  without override: ${res.status} ${await errorCode(res)}`);
  }
  const res = await confirm(base, id, analysed.plan.planId, expect === 'review' ? true : undefined);
  if (!res.ok) throw new Error(`${file}: confirm → ${res.status} ${await errorCode(res)}`);
  const final = await waitFor(base, id, ['PAID', 'FAILED', 'REJECTED', 'BLOCKED', 'SCHEDULED'], seen);
  if (final.invoice.state !== 'PAID')
    throw new Error(`${file}: payment ended in ${final.invoice.state}, expected PAID`);
  console.log(
    `  PAID · transfer ${final.execution?.transferId} · txid ${final.execution?.txid?.slice(0, 16) ?? 'n/a'}…`,
  );
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

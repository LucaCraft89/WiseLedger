// Persistence, restart recovery, 409 on invalid transitions, sha256 uploads and health — on a temp DB file.
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppEvent } from 'core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/server.js';
import { InvoiceStore, SCHEMA_VERSION, type StoredInvoice } from '../src/store.js';

let dir: string;
let uploadDir: string;
let dbPath: string;
let built: App | undefined;

async function start(): Promise<App> {
  built = await createApp({ uploadDir, dbPath, mockStepMs: 0 });
  return built;
}

async function stop(): Promise<void> {
  await built?.app.close();
  built = undefined;
}

async function get(url: string) {
  if (!built) throw new Error('no app');
  return built.app.inject({ method: 'GET', url });
}

async function post(url: string, payload: unknown) {
  if (!built) throw new Error('no app');
  return built.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
}

async function waitForState(id: string, states: string[], timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = (await get(`/api/invoices/${id}`)).json().invoice.state as string;
    if (states.includes(state) || Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function multipart(filename: string, content: string) {
  const boundary = '----wiseledger';
  return {
    payload: [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: text/plain',
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function record(id: string, state: StoredInvoice['state'], path: string): StoredInvoice {
  const at = new Date().toISOString();
  return { id, state, filename: `${id}.txt`, kind: 'text', sha256: 'f'.repeat(64), path, createdAt: at, updatedAt: at };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiseledger-persist-'));
  uploadDir = join(dir, 'uploads');
  dbPath = join(dir, 'db', 'app.db');
});

afterEach(async () => {
  await stop();
  await rm(dir, { recursive: true, force: true });
});

describe('SQLite store', () => {
  it('migrates once to the current schema version', async () => {
    const s1 = new InvoiceStore(dbPath);
    expect(s1.schemaVersion).toBe(SCHEMA_VERSION);
    const tables = (s1.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
      .sort();
    expect(tables).toEqual(
      expect.arrayContaining(['confirmations', 'events', 'executions', 'invoices', 'plans', 'reports']),
    );
    s1.close();
    const s2 = new InvoiceStore(dbPath);
    expect(s2.schemaVersion).toBe(SCHEMA_VERSION);
    s2.close();
  });
});

describe('restart mid-flow', () => {
  it('keeps invoice states and events across restarts, then finishes the payment', async () => {
    await start();
    const created = await post('/api/invoices', { text: 'Invoice 2026-042, Acme Srl', filename: 'ok-basic.txt' });
    expect(created.statusCode).toBe(201);
    const id = created.json().invoiceId as string;
    expect(await waitForState(id, ['AWAITING_CONFIRMATION', 'FAILED'])).toBe('AWAITING_CONFIRMATION');
    const before = (await get(`/api/invoices/${id}`)).json();
    await stop();

    // Restart on the same DB file.
    await start();
    const after = (await get(`/api/invoices/${id}`)).json();
    expect(after.invoice.state).toBe('AWAITING_CONFIRMATION');
    expect(after.plan).toEqual(before.plan);
    expect(after.report).toEqual(before.report);
    expect(after.confirmationSentence).toBe(before.confirmationSentence);
    expect(after.events).toEqual(before.events);
    expect((await get('/api/invoices')).json().invoices.map((i: { id: string }) => i.id)).toEqual([id]);

    // SSE replay comes from the DB, so it survives the restart.
    const url = await built?.app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/invoices/${id}/events`, { signal: ctrl.signal });
    const reader = res.body?.getReader();
    let text = '';
    while (reader && !text.includes('"to":"AWAITING_CONFIRMATION"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    expect(text).toContain('"to":"UPLOADED"');

    const confirm = await post(`/api/invoices/${id}/confirm`, { planId: before.plan.planId });
    expect(confirm.statusCode).toBe(200);
    expect(await waitForState(id, ['PAID', 'FAILED'])).toBe('PAID');
    await stop();

    await start();
    const final = (await get(`/api/invoices/${id}`)).json();
    expect(final.invoice.state).toBe('PAID');
    expect(final.execution.status).toBe('settled');
    expect(final.events.filter((e: AppEvent) => e.type === 'state').map((e: { to: string }) => e.to)).toEqual([
      'UPLOADED',
      'EXTRACTED',
      'ANALYZED',
      'AWAITING_CONFIRMATION',
      'CONFIRMED',
      'EXECUTING',
      'PAID',
    ]);
    expect(built?.store.invoiceForTransfer(final.execution.transferId)).toBe(id);
  });

  it('re-analyses interrupted analysis, fails it when the upload is gone, never re-executes a payment', async () => {
    const file = join(dir, 'stuck.txt');
    await writeFile(file, 'Invoice 2026-042');
    const seed = new InvoiceStore(dbPath);
    seed.insert(record('inv_uploaded', 'UPLOADED', file));
    seed.insert(record('inv_extracted', 'EXTRACTED', file));
    seed.insert(record('inv_nofile', 'UPLOADED', join(dir, 'missing.txt')));
    seed.insert(record('inv_paying', 'EXECUTING', file));
    seed.update('inv_paying', { result: { planId: 'p'.repeat(64), status: 'submitted', transferId: 'tr_1' } });
    seed.close();

    await start();
    expect(await waitForState('inv_uploaded', ['AWAITING_CONFIRMATION', 'FAILED'])).toBe('AWAITING_CONFIRMATION');
    expect(await waitForState('inv_extracted', ['AWAITING_CONFIRMATION', 'FAILED'])).toBe('AWAITING_CONFIRMATION');
    expect(await waitForState('inv_nofile', ['FAILED'])).toBe('FAILED');
    const nofile = (await get('/api/invoices/inv_nofile')).json();
    expect(nofile.events.some((e: AppEvent) => e.type === 'error' && e.code === 'UPLOAD_MISSING')).toBe(true);

    await built?.orchestrator.idle();
    const paying = (await get('/api/invoices/inv_paying')).json();
    expect(paying.invoice.state).toBe('EXECUTING');
    expect(paying.execution.status).toBe('submitted');
    expect(paying.events.some((e: AppEvent) => e.type === 'stage' && e.stage === 'executing')).toBe(true);
    expect(paying.events.some((e: AppEvent) => e.type === 'state')).toBe(false);

    const health = (await get('/api/health')).json();
    expect(health.problems.join(' ')).toContain('inv_paying');
    const executing = (await get('/api/invoices?state=EXECUTING')).json().invoices;
    expect(executing.map((i: { id: string }) => i.id)).toEqual(['inv_paying']);
  });
});

describe('invalid transitions', () => {
  it('returns 409 INVALID_TRANSITION and leaves the state unchanged', async () => {
    await start();
    const id = (await post('/api/invoices', { text: 'Invoice', filename: 'ok-basic.txt' })).json().invoiceId as string;
    await waitForState(id, ['AWAITING_CONFIRMATION']);
    const planId = (await get(`/api/invoices/${id}`)).json().plan.planId as string;

    expect((await post(`/api/invoices/${id}/reject`, {})).statusCode).toBe(200);
    const again = await post(`/api/invoices/${id}/reject`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVALID_TRANSITION');
    expect(again.json().error.message).toContain('REJECTED');

    const confirm = await post(`/api/invoices/${id}/confirm`, { planId });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().error.code).toBe('INVALID_TRANSITION');
    expect(await waitForState(id, ['REJECTED'])).toBe('REJECTED');
  });
});

describe('uploads', () => {
  it('stores the file under its sha256 and keeps the original filename in the record', async () => {
    await start();
    const content = 'Invoice 2026-042, Acme Srl, 25.00 TUSDT';
    const sha = createHash('sha256').update(content).digest('hex');
    const first = await built?.app.inject({
      method: 'POST',
      url: '/api/invoices',
      ...multipart('Fattura Acme.txt', content),
    });
    expect(first?.statusCode).toBe(201);
    const id = first?.json().invoiceId as string;

    expect(await readFile(join(uploadDir, `${sha}.txt`), 'utf8')).toBe(content);
    expect((await get(`/api/invoices/${id}`)).json().invoice.filename).toBe('Fattura Acme.txt');
    const stored = built?.store.get(id);
    expect(stored?.sha256).toBe(sha);
    expect(stored?.path).toBe(join(uploadDir, `${sha}.txt`));

    // Same bytes again: a new invoice, the same single file on disk.
    const second = await built?.app.inject({ method: 'POST', url: '/api/invoices', ...multipart('copy.txt', content) });
    expect(second?.json().invoiceId).not.toBe(id);
    expect(await readdir(uploadDir)).toEqual([`${sha}.txt`]);
  });
});

describe('health', () => {
  it('reports provider, model, wallet backend and network', async () => {
    built = await createApp({ uploadDir, dbPath, mockStepMs: 0, rgbNetwork: 'regtest' });
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      llm: { provider: 'mock', model: 'mock-analyzer', state: 'ready', onDevice: true },
      wallet: { backend: 'mock', network: 'regtest', ready: true },
      problems: [],
    });
  });
});

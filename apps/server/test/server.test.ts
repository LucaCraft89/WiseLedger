import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/server.js';

let dir: string;
let built: App;

async function waitForState(id: string, states: string[], timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await built.app.inject({ method: 'GET', url: `/api/invoices/${id}` });
    const state = res.json().invoice.state as string;
    if (states.includes(state) || Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function upload(filename: string, text: string): Promise<string> {
  const res = await built.app.inject({ method: 'POST', url: '/api/invoices', payload: { text, filename } });
  expect(res.statusCode).toBe(201);
  return res.json().invoiceId as string;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiseledger-server-'));
  built = await createApp({ uploadDir: dir, mockStepMs: 0 });
});

afterEach(async () => {
  await built.app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('server on mocks', () => {
  it('GET /api/health reports mock backends', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.llm.provider).toBe('mock');
    expect(body.wallet.backend).toBe('mock');
  });

  it('upload → confirm → PAID', async () => {
    const id = await upload('ok-basic.txt', 'Invoice 2026-042, Acme Srl, 25.00 TUSDT');
    expect(await waitForState(id, ['AWAITING_CONFIRMATION', 'BLOCKED', 'FAILED'])).toBe('AWAITING_CONFIRMATION');
    const detail = (await built.app.inject({ method: 'GET', url: `/api/invoices/${id}` })).json();
    expect(detail.confirmationSentence).toContain('25.000000 TUSDT');
    const planId = detail.plan.planId as string;

    const res = await built.app.inject({ method: 'POST', url: `/api/invoices/${id}/confirm`, payload: { planId } });
    expect(res.statusCode).toBe(200);
    expect(res.json().planId).toBe(planId);
    expect(await waitForState(id, ['PAID', 'FAILED'])).toBe('PAID');

    const transfers = (await built.app.inject({ method: 'GET', url: '/api/transfers' })).json().transfers;
    expect(transfers.some((t: { invoiceId?: string }) => t.invoiceId === id)).toBe(true);
    const states = (await built.app.inject({ method: 'GET', url: `/api/invoices/${id}` }))
      .json()
      .events.filter((e: { type: string }) => e.type === 'state')
      .map((e: { to: string }) => e.to);
    expect(states).toEqual([
      'UPLOADED',
      'EXTRACTED',
      'ANALYZED',
      'AWAITING_CONFIRMATION',
      'CONFIRMED',
      'EXECUTING',
      'PAID',
    ]);
  });

  it('rejects a confirm with the wrong planId', async () => {
    const id = await upload('ok-basic.txt', 'Invoice');
    await waitForState(id, ['AWAITING_CONFIRMATION']);
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/invoices/${id}/confirm`,
      payload: { planId: 'f'.repeat(64) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PLAN_MISMATCH');
    expect(await waitForState(id, ['AWAITING_CONFIRMATION'])).toBe('AWAITING_CONFIRMATION');
  });

  it('blocks a scam invoice and refuses to confirm it', async () => {
    const id = await upload('scam-bank-change.txt', 'Urgent: our bank details have changed');
    expect(await waitForState(id, ['BLOCKED', 'AWAITING_CONFIRMATION'])).toBe('BLOCKED');
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/invoices/${id}/confirm`,
      payload: { planId: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('VERDICT_BLOCK');
  });

  it('accepts a multipart upload', async () => {
    const boundary = '----wiseledger';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="ok-basic.txt"',
      'Content-Type: text/plain',
      '',
      'Invoice 2026-042',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/invoices',
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('UPLOADED');
  });

  it('streams past events over SSE', async () => {
    const id = await upload('ok-basic.txt', 'Invoice');
    await waitForState(id, ['AWAITING_CONFIRMATION']);
    const url = (await built.app.listen({ port: 0, host: '127.0.0.1' })) as string;
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/invoices/${id}/events`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    let text = '';
    while (reader && !text.includes('AWAITING_CONFIRMATION')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    expect(text).toContain('event: app');
    expect(text).toContain('"to":"UPLOADED"');
  });

  it('returns a plain error for unknown invoices and bad bodies', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/invoices/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    const bad = await built.app.inject({ method: 'POST', url: '/api/invoices', payload: { text: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION');
  });
});

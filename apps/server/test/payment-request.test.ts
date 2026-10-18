// A document that is only a payment request, end to end on mocks with the real Analyst (no model call needed).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLlm } from 'core/mocks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/server.js';

let dir: string;
let built: App;
let llm: MockLlm;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiseledger-pr-'));
  llm = new MockLlm({ replies: [] }); // the payment request path never calls the model
  built = await createApp(
    { uploadDir: dir, dbPath: ':memory:', mockStepMs: 0, llmProvider: 'openai' },
    { providers: { llm } },
  );
});
afterEach(async () => {
  await built.app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (id: string) => (await built.app.inject({ method: 'GET', url: `/api/invoices/${id}` })).json();

describe('only a payment request, through the server', () => {
  it('open amount: no plan until the user types it; checked (> 0, ≤ cap); review needs the tick; then PAID', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/invoices',
      payload: { text: '  rgb:mock/any/any/1900000000  ', filename: 'pasted.txt' },
    });
    const id = res.json().invoiceId as string;
    await built.orchestrator.idle();
    let d = await get(id);
    expect(llm.calls).toHaveLength(0);
    expect(d.invoice.state).toBe('AWAITING_CONFIRMATION');
    expect(d.report).toMatchObject({ kind: 'payment_request', verdict: 'review', paymentRequest: { network: 'mock' } });
    expect(d.report.paymentRequest.amount).toBeUndefined();
    expect(d.plan).toBeUndefined();

    const confirm = (body: object) =>
      built.app.inject({ method: 'POST', url: `/api/invoices/${id}/confirm`, payload: body });
    expect((await confirm({ planId: 'x' })).json().error.code).toBe('AMOUNT_NEEDED');
    const amount = (a: string) =>
      built.app.inject({ method: 'POST', url: `/api/invoices/${id}/amount`, payload: { amount: a } });
    expect((await amount('0')).json().error.code).toBe('AMOUNT_ZERO');
    expect((await amount('200000000')).json().error).toMatchObject({
      code: 'OVER_CAP',
      message: 'This is above your payment limit of 100.00 TUSDT. Type a smaller amount.',
    });
    const set = (await amount('5000000')).json();
    expect(set.confirmationSentence).toBe(
      'Pay 5.00 TUSDT (asset rgb:mock-tusdt) to whoever sent this payment request, now. Confirm?',
    );
    d = await get(id);
    expect(d.plan.planId).toBe(set.plan.planId);
    expect((await confirm({ planId: set.plan.planId })).json().error.code).toBe('OVERRIDE_REQUIRED');
    expect(llm.calls).toHaveLength(0); // analysis, amount and sentence: all code
    // The Treasurer (a model call with tools) pays the confirmed plan.
    llm.push({ toolCall: { name: 'execute_plan', arguments: { planId: set.plan.planId } } });
    expect((await confirm({ planId: set.plan.planId, override: true })).statusCode).toBe(200);
    await built.orchestrator.idle();
    for (let i = 0; i < 50 && (await get(id)).invoice.state !== 'PAID'; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect((await get(id)).invoice.state).toBe('PAID');
    // Once paid, the amount cannot be set again.
    expect((await amount('1000000')).json().error.code).toBe('INVALID_TRANSITION');
  });

  it('"pay this: rgb:…" in the chat opens the same check; nothing is paid from the chat', async () => {
    const reply = (
      await built.app.inject({
        method: 'POST',
        url: '/api/agent/chat',
        payload: { message: 'pay this: rgb:mock/rgb:mock-tusdt/25000000/1900000000' },
      })
    ).json();
    expect(reply.needsConfirmation).toBeUndefined();
    const invoiceId = reply.toolCalls[0].result.invoiceId as string;
    expect(reply.toolCalls[0].name).toBe('check_payment_request');
    await built.orchestrator.idle();
    const d = await get(invoiceId);
    expect(d.report).toMatchObject({
      kind: 'payment_request',
      verdict: 'review',
      paymentRequest: { amount: '25000000' },
    });
    expect(d.invoice.state).toBe('AWAITING_CONFIRMATION');
    expect(llm.calls).toHaveLength(0);
    expect(
      (
        await built.app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/amount`, payload: { amount: '1' } })
      ).json().error.code,
    ).toBe('AMOUNT_FIXED');
  });
});

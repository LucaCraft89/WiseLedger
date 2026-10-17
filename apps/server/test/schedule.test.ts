// Scheduled payments end to end on mocks: confirm with executeAt → SCHEDULED + job → due tick pays once through the
// guard; cancel; past dates refused.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from 'core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/server.js';

let dir: string;
let built: App;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function state(id: string): Promise<string> {
  return (await built.app.inject({ method: 'GET', url: `/api/invoices/${id}` })).json().invoice.state as string;
}

async function waitForState(id: string, states: string[], timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await state(id);
    if (states.includes(s) || Date.now() > deadline) return s;
    await sleep(10);
  }
}

async function readyInvoice(): Promise<{ id: string; planId: string }> {
  const res = await built.app.inject({
    method: 'POST',
    url: '/api/invoices',
    payload: { text: 'Invoice 2026-042, Acme Srl, 25.00 TUSDT', filename: 'ok-basic.txt' },
  });
  const id = res.json().invoiceId as string;
  expect(await waitForState(id, ['AWAITING_CONFIRMATION', 'BLOCKED', 'FAILED'])).toBe('AWAITING_CONFIRMATION');
  const detail = (await built.app.inject({ method: 'GET', url: `/api/invoices/${id}` })).json();
  return { id, planId: detail.plan.planId as string };
}

async function jobs(): Promise<Job[]> {
  return (await built.app.inject({ method: 'GET', url: '/api/schedule' })).json().jobs as Job[];
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiseledger-schedule-'));
  // A long runner period: the tests drive the Scheduler with tick().
  built = await createApp({ uploadDir: dir, dbPath: ':memory:', mockStepMs: 0 }, { schedulerMs: 3_600_000 });
});

afterEach(async () => {
  await built.app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('scheduled payments', () => {
  it('confirm with executeAt → SCHEDULED with a job; when due it pays once', async () => {
    const { id, planId } = await readyInvoice();
    const executeAt = new Date(Date.now() + 1200).toISOString();
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/invoices/${id}/confirm`,
      payload: { planId, executeAt },
    });
    expect(res.statusCode).toBe(200);
    const scheduledPlanId = res.json().planId as string;
    expect(scheduledPlanId).not.toBe(planId); // the date is part of the plan hash
    expect(await waitForState(id, ['SCHEDULED', 'FAILED'])).toBe('SCHEDULED');
    const [job] = await jobs();
    if (!job) throw new Error('no job');
    expect(job).toMatchObject({ invoiceId: id, planId: scheduledPlanId, status: 'pending' });

    expect(await built.scheduler.tick()).toBe(0); // not due yet
    expect(await state(id)).toBe('SCHEDULED');

    await sleep(1300);
    expect(await built.scheduler.tick()).toBe(1);
    expect(await waitForState(id, ['PAID', 'FAILED'])).toBe('PAID');
    expect((await jobs())[0]?.status).toBe('done');
    const paid = (await built.app.inject({ method: 'GET', url: '/api/transfers' }))
      .json()
      .transfers.filter((t: { invoiceId?: string }) => t.invoiceId === id);
    expect(paid).toHaveLength(1);

    // A second run of the same job (e.g. a crash left it running) never pays again.
    expect(await built.orchestrator.runScheduled({ ...job, status: 'running' })).toMatchObject({
      status: 'failed',
      error: { code: 'already_executed' },
    });
  });

  it('cancel → the job never runs and the invoice is rejected', async () => {
    const { id, planId } = await readyInvoice();
    const executeAt = new Date(Date.now() + 60_000).toISOString();
    await built.app.inject({ method: 'POST', url: `/api/invoices/${id}/confirm`, payload: { planId, executeAt } });
    expect(await waitForState(id, ['SCHEDULED', 'FAILED'])).toBe('SCHEDULED');
    const [job] = await jobs();
    if (!job) throw new Error('no job');
    const res = await built.app.inject({ method: 'POST', url: `/api/schedule/${job.jobId}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(await state(id)).toBe('REJECTED');
    expect(await built.orchestrator.runScheduled({ ...job, status: 'pending' })).toMatchObject({
      status: 'failed',
      error: { code: 'NOT_SCHEDULED' },
    });
  });

  it('a date in the past is refused before anything changes', async () => {
    const { id, planId } = await readyInvoice();
    const res = await built.app.inject({
      method: 'POST',
      url: `/api/invoices/${id}/confirm`,
      payload: { planId, executeAt: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IN_THE_PAST');
    expect(await state(id)).toBe('AWAITING_CONFIRMATION');
    expect(await jobs()).toHaveLength(0);
  });
});

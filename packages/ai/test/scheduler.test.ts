import type { ExecutionResult, Job } from 'core';
import { MemoryJobStore } from 'core/mocks';
import { describe, expect, it } from 'vitest';
import { ScheduleError, Scheduler } from '../src/scheduler.js';

function setup(confirmed = new Set(['p1'])) {
  let now = new Date('2026-10-17T10:00:00Z');
  const jobs = new MemoryJobStore();
  const paid: string[] = [];
  const executed = new Set<string>(); // the guard's claim: a plan runs once
  const s = new Scheduler({
    jobs,
    now: () => now,
    hasConfirmation: async (planId) => confirmed.has(planId),
    execute: async (job: Job): Promise<ExecutionResult> => {
      if (executed.has(job.planId))
        return { planId: job.planId, status: 'failed', error: { code: 'already_executed', message: 'already paid' } };
      executed.add(job.planId);
      paid.push(job.planId);
      return { planId: job.planId, status: 'settled', transferId: `t-${job.planId}` };
    },
  });
  return { s, jobs, paid, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('Scheduler', () => {
  it('schedule → not due yet → due → paid once', async () => {
    const { s, jobs, paid, setNow } = setup();
    const job = await s.schedule({ planId: 'p1', invoiceId: 'inv_1', runAt: '2026-10-23T09:00:00Z' });
    expect(job.status).toBe('pending');
    expect(await s.tick()).toBe(0);
    setNow('2026-10-23T09:00:30Z');
    expect(await s.tick()).toBe(1);
    expect(paid).toEqual(['p1']);
    expect((await jobs.list())[0]).toMatchObject({ status: 'done', result: { status: 'settled' } });
    expect(await s.tick()).toBe(0);
  });

  it('refuses unconfirmed plans, past and invalid dates', async () => {
    const { s } = setup();
    await expect(s.schedule({ planId: 'nope', invoiceId: 'i', runAt: '2026-10-23T09:00:00Z' })).rejects.toMatchObject({
      code: 'NOT_CONFIRMED',
    });
    await expect(s.schedule({ planId: 'p1', invoiceId: 'i', runAt: '2026-10-01T09:00:00Z' })).rejects.toBeInstanceOf(
      ScheduleError,
    );
    await expect(s.schedule({ planId: 'p1', invoiceId: 'i', runAt: 'Friday' })).rejects.toMatchObject({
      code: 'BAD_DATE',
    });
  });

  it('cancel stops a pending job', async () => {
    const { s, paid, setNow } = setup();
    const job = await s.schedule({ planId: 'p1', invoiceId: 'inv_1', runAt: '2026-10-23T09:00:00Z' });
    expect(await s.cancel(job.jobId)).toBe(true);
    setNow('2026-10-24T00:00:00Z');
    expect(await s.tick()).toBe(0);
    expect(paid).toEqual([]);
  });

  it('restart recovery: a missed job runs once; a job left running by a crash is never paid twice', async () => {
    const { s, jobs, paid, setNow } = setup(new Set(['p1', 'p2']));
    await s.schedule({ planId: 'p1', invoiceId: 'inv_1', runAt: '2026-10-18T09:00:00Z' });
    const crashed = await s.schedule({ planId: 'p2', invoiceId: 'inv_2', runAt: '2026-10-18T09:00:00Z' });
    setNow('2026-10-19T08:00:00Z'); // server was down when both were due
    // p2 had started before the crash: it went out, and the job was left 'running'.
    await jobs.put({ ...crashed, status: 'running' });
    paid.push('p2-before-crash');
    // Simulate the guard already holding p2's claim.
    const s2 = new Scheduler({
      jobs,
      now: () => new Date('2026-10-19T08:00:00Z'),
      hasConfirmation: async () => true,
      execute: async (job) => {
        if (job.planId === 'p2') {
          return { planId: 'p2', status: 'failed', error: { code: 'already_executed', message: 'already paid' } };
        }
        paid.push(job.planId);
        return { planId: job.planId, status: 'settled' };
      },
    });
    expect(await s2.tick()).toBe(2);
    expect(paid).toEqual(['p2-before-crash', 'p1']);
    void s;
    void setNow;
  });
});

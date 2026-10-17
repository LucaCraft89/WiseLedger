// Scheduled payments (born from "pay the Acme invoice on Friday"). Jobs live in A's JobStore; due jobs run through
// an injected executor that goes through A's PaymentGuard. Money never moves without a stored human confirmation.
import type { ExecutionResult, Job, JobStore } from 'core';

export interface SchedulerDeps {
  jobs: JobStore;
  /** True when a human Confirmation for this plan is stored (the server checks its store). */
  hasConfirmation(planId: string): Promise<boolean>;
  /** Runs the confirmed plan now, through the PaymentGuard (claim-first: a second run returns already_executed). */
  execute(job: Job): Promise<ExecutionResult>;
  now?: () => Date;
  /** Runner period. Default 30 s. */
  intervalMs?: number;
  onResult?: (job: Job, result: ExecutionResult) => void;
}

export class ScheduleError extends Error {
  constructor(
    readonly code: 'NOT_CONFIRMED' | 'IN_THE_PAST' | 'BAD_DATE',
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<number> | undefined;
  private seq = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Stores a job for a confirmed plan. `runAt` must be a valid ISO time not in the past (1 min grace). */
  async schedule(input: { planId: string; invoiceId: string; runAt: string }): Promise<Job> {
    const t = Date.parse(input.runAt);
    if (Number.isNaN(t)) throw new ScheduleError('BAD_DATE', 'That date is not valid.');
    if (t < this.now().getTime() - 60_000) throw new ScheduleError('IN_THE_PAST', 'That date is in the past.');
    if (!(await this.deps.hasConfirmation(input.planId))) {
      throw new ScheduleError('NOT_CONFIRMED', 'This payment must be confirmed before it can be scheduled.');
    }
    const at = this.now().toISOString();
    const job: Job = {
      jobId: `job_${Date.now().toString(36)}_${(++this.seq).toString(36)}`,
      planId: input.planId,
      invoiceId: input.invoiceId,
      runAt: new Date(t).toISOString(),
      status: 'pending',
      createdAt: at,
      updatedAt: at,
    };
    await this.deps.jobs.put(job);
    return job;
  }

  cancel(jobId: string): Promise<boolean> {
    return this.deps.jobs.cancel(jobId);
  }

  list(): Promise<Job[]> {
    return this.deps.jobs.list();
  }

  /**
   * Runs every due job once. Also picks up jobs left 'running' by a crash: they go through the guard again, which
   * refuses a plan already executed, so a restart can never pay twice. Returns how many jobs ran.
   */
  tick(): Promise<number> {
    this.ticking ??= this.runDue().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async runDue(): Promise<number> {
    const now = this.now().toISOString();
    const due = [
      ...(await this.deps.jobs.list({ status: 'pending', dueBefore: now })),
      ...(await this.deps.jobs.list({ status: 'running' })),
    ];
    let ran = 0;
    for (const job of due) {
      if (!(await this.deps.hasConfirmation(job.planId))) {
        await this.finish(job, {
          planId: job.planId,
          status: 'failed',
          error: { code: 'not_confirmed', message: 'No confirmation stored.' },
        });
        continue;
      }
      await this.deps.jobs.put({ ...job, status: 'running', updatedAt: this.now().toISOString() });
      let result: ExecutionResult;
      try {
        result = await this.deps.execute(job);
      } catch (err) {
        result = {
          planId: job.planId,
          status: 'failed',
          error: { code: 'SCHEDULER', message: err instanceof Error ? err.message : String(err) },
        };
      }
      await this.finish(job, result);
      ran++;
    }
    return ran;
  }

  private async finish(job: Job, result: ExecutionResult): Promise<void> {
    await this.deps.jobs.markDone(job.jobId, result); // failed results → status 'failed', else 'done'
    this.deps.onResult?.(job, result);
  }

  start(): void {
    if (this.timer) return;
    void this.tick(); // jobs missed while the server was down run once at start
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

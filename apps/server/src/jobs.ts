// Scheduled payment jobs on the SQLite app DB. Same semantics as core's MemoryJobStore: list sorted by runAt,
// cancel only pending jobs, markDone → done | failed (lastError from the result). Lane B's scheduler runs them.
import type { ExecutionResult, Job, JobStatus, JobStore } from 'core';
import type { InvoiceStore } from './store.js';

interface Row {
  job_id: string;
  plan_id: string;
  invoice_id: string;
  run_at: string;
  status: string;
  created_at: string;
  updated_at: string;
  result_json: string | null;
  last_error: string | null;
}

function toJob(row: Row): Job {
  return {
    jobId: row.job_id,
    planId: row.plan_id,
    invoiceId: row.invoice_id,
    runAt: row.run_at,
    status: row.status as JobStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.result_json ? { result: JSON.parse(row.result_json) as ExecutionResult } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

export class SqliteJobStore implements JobStore {
  constructor(
    private readonly store: InvoiceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Inserts or replaces the job (upsert by jobId). */
  async put(job: Job): Promise<void> {
    this.store.db
      .prepare(
        `INSERT INTO jobs (job_id, plan_id, invoice_id, run_at, status, created_at, updated_at, result_json, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET plan_id = excluded.plan_id, invoice_id = excluded.invoice_id,
           run_at = excluded.run_at, status = excluded.status, created_at = excluded.created_at,
           updated_at = excluded.updated_at, result_json = excluded.result_json, last_error = excluded.last_error`,
      )
      .run(
        job.jobId,
        job.planId,
        job.invoiceId,
        job.runAt,
        job.status,
        job.createdAt,
        job.updatedAt,
        job.result ? JSON.stringify(job.result) : null,
        job.lastError ?? null,
      );
  }

  async get(jobId: string): Promise<Job | null> {
    const row = this.store.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as Row | undefined;
    return row ? toJob(row) : null;
  }

  async list(filter: { status?: JobStatus; dueBefore?: string } = {}): Promise<Job[]> {
    const rows = this.store.db.prepare('SELECT * FROM jobs').all() as unknown as Row[];
    // Filter and sort on parsed timestamps (runAt may carry any offset), like MemoryJobStore.
    return rows
      .map(toJob)
      .filter((j) => !filter.status || j.status === filter.status)
      .filter((j) => !filter.dueBefore || Date.parse(j.runAt) <= Date.parse(filter.dueBefore))
      .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt) || a.createdAt.localeCompare(b.createdAt));
  }

  async cancel(jobId: string): Promise<boolean> {
    const res = this.store.db
      .prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status = 'pending'")
      .run(this.now().toISOString(), jobId);
    return Number(res.changes) === 1;
  }

  async markDone(jobId: string, result: ExecutionResult): Promise<void> {
    const status: JobStatus = result.status === 'failed' ? 'failed' : 'done';
    this.store.db
      .prepare(
        `UPDATE jobs SET status = ?, result_json = ?, updated_at = ?, last_error = COALESCE(?, last_error) WHERE job_id = ?`,
      )
      .run(status, JSON.stringify(result), this.now().toISOString(), result.error?.message ?? null, jobId);
  }
}

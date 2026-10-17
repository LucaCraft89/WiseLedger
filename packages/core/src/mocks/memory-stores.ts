// In-memory JobStore and LabelStore (stubs for tests and lane B's scheduler; SQLite versions live in apps/server).
import type { ExecutionResult, Job, JobStatus, JobStore, LabelEntry, LabelStore } from '../orchestrator.js';

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();

  async put(job: Job): Promise<void> {
    this.jobs.set(job.jobId, { ...job });
  }

  async list(filter: { status?: JobStatus; dueBefore?: string } = {}): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((j) => !filter.status || j.status === filter.status)
      .filter((j) => !filter.dueBefore || Date.parse(j.runAt) <= Date.parse(filter.dueBefore))
      .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (job?.status !== 'pending') return false;
    this.jobs.set(jobId, { ...job, status: 'cancelled', updatedAt: new Date().toISOString() });
    return true;
  }

  async markDone(jobId: string, result: ExecutionResult): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const status: JobStatus = result.status === 'failed' ? 'failed' : 'done';
    this.jobs.set(jobId, {
      ...job,
      status,
      result,
      updatedAt: new Date().toISOString(),
      ...(result.error ? { lastError: result.error.message } : {}),
    });
  }
}

export class MemoryLabelStore implements LabelStore {
  private readonly entries = new Map<string, LabelEntry>();

  async set(targetId: string, labels: string[], note?: string): Promise<LabelEntry> {
    const entry: LabelEntry = { targetId, labels, updatedAt: new Date().toISOString(), ...(note ? { note } : {}) };
    this.entries.set(targetId, entry);
    return entry;
  }

  async get(targetId: string): Promise<LabelEntry | null> {
    return this.entries.get(targetId) ?? null;
  }

  async list(): Promise<LabelEntry[]> {
    return [...this.entries.values()];
  }
}

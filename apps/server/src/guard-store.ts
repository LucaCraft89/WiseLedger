// PaymentGuard storage on the SQLite invoice store. find() resolves plan + invoice state + confirmation by planId;
// claim() is the idempotency key (INSERT … ON CONFLICT DO NOTHING, atomic in SQLite, persisted across restarts).
import type { InvoiceState, PaymentPlan } from 'core';
import type { GuardRecord, GuardStore } from 'wallet';
import type { InvoiceStore } from './store.js';

interface Row {
  plan_json: string;
  state: string;
  c_plan_id: string | null;
  confirmed_at: string | null;
}

export class SqliteGuardStore implements GuardStore {
  constructor(
    private readonly store: InvoiceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async find(planId: string): Promise<GuardRecord | null> {
    // Newest invoice first: the same plan cannot belong to two invoices (invoiceId is part of the hash).
    const row = this.store.db
      .prepare(
        `SELECT p.plan_json, i.state, c.plan_id AS c_plan_id, c.confirmed_at
         FROM plans p
         JOIN invoices i ON i.id = p.invoice_id
         LEFT JOIN confirmations c ON c.invoice_id = p.invoice_id
         WHERE p.plan_id = ?
         ORDER BY i.created_at DESC
         LIMIT 1`,
      )
      .get(planId) as Row | undefined;
    if (!row) return null;
    return {
      plan: JSON.parse(row.plan_json) as PaymentPlan,
      state: row.state as InvoiceState,
      ...(row.c_plan_id && row.confirmed_at
        ? { confirmation: { planId: row.c_plan_id, confirmedAt: row.confirmed_at } }
        : {}),
    };
  }

  async claim(planId: string): Promise<boolean> {
    const res = this.store.db
      .prepare('INSERT INTO guard_claims (plan_id, claimed_at) VALUES (?, ?) ON CONFLICT(plan_id) DO NOTHING')
      .run(planId, this.now().toISOString());
    return Number(res.changes) === 1;
  }

  async release(planId: string): Promise<void> {
    this.store.db.prepare('DELETE FROM guard_claims WHERE plan_id = ?').run(planId);
  }

  /** True when the plan has an active claim (tests, diagnostics). */
  isClaimed(planId: string): boolean {
    return this.store.db.prepare('SELECT 1 FROM guard_claims WHERE plan_id = ?').get(planId) !== undefined;
  }
}

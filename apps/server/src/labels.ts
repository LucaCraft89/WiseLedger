// Labels on the SQLite app DB: per transfer (targetId = transferId), per unpaid invoice (invoiceId) or per payee
// (targetId = `payee:<name lowercased>`). A transfer's effective labels = its own ∪ its plan's ∪ its payee's.
import type { LabelEntry, LabelStore } from 'core';
import type { InvoiceStore } from './store.js';

export const PAYEE_PREFIX = 'payee:';

/** Label target of a payee: `payee:<name trimmed, inner spaces collapsed, lowercased>`. */
export function payeeTarget(name: string): string {
  return `${PAYEE_PREFIX}${name.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

/** Payee targets are normalized (so "payee:Acme Srl" and "payee:acme srl" are one target); others are trimmed. */
export function normalizeTarget(targetId: string): string {
  const t = targetId.trim();
  return t.toLowerCase().startsWith(PAYEE_PREFIX) ? payeeTarget(t.slice(PAYEE_PREFIX.length)) : t;
}

/** Trimmed, empty ones dropped, duplicates (case-insensitive) dropped, first spelling kept. */
export function normalizeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const l = raw.trim().replace(/\s+/g, ' ');
    const key = l.toLowerCase();
    if (!l || seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

interface Row {
  target_id: string;
  labels_json: string;
  note: string | null;
  updated_at: string;
}

function toEntry(row: Row): LabelEntry {
  return {
    targetId: row.target_id,
    labels: JSON.parse(row.labels_json) as string[],
    updatedAt: row.updated_at,
    ...(row.note ? { note: row.note } : {}),
  };
}

export class SqliteLabelStore implements LabelStore {
  constructor(
    private readonly store: InvoiceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Replaces the labels of a target. An empty list with no note removes the entry (returned with labels []). */
  async set(targetId: string, labels: string[], note?: string): Promise<LabelEntry> {
    const target = normalizeTarget(targetId);
    const clean = normalizeLabels(labels);
    const updatedAt = this.now().toISOString();
    const n = note?.trim() || undefined;
    if (clean.length === 0 && !n) {
      this.store.db.prepare('DELETE FROM labels WHERE target_id = ?').run(target);
    } else {
      this.store.db
        .prepare(
          `INSERT INTO labels (target_id, labels_json, note, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(target_id) DO UPDATE SET labels_json = excluded.labels_json, note = excluded.note, updated_at = excluded.updated_at`,
        )
        .run(target, JSON.stringify(clean), n ?? null, updatedAt);
    }
    return { targetId: target, labels: clean, updatedAt, ...(n ? { note: n } : {}) };
  }

  async get(targetId: string): Promise<LabelEntry | null> {
    const row = this.store.db.prepare('SELECT * FROM labels WHERE target_id = ?').get(normalizeTarget(targetId)) as
      | Row
      | undefined;
    return row ? toEntry(row) : null;
  }

  async list(): Promise<LabelEntry[]> {
    const rows = this.store.db.prepare('SELECT * FROM labels ORDER BY target_id').all() as unknown as Row[];
    return rows.map(toEntry);
  }

  /** Payee name of a transfer, via transfer → invoice → plan.payee. */
  payeeOf(transferId: string): string | undefined {
    const invoiceId = this.store.invoiceForTransfer(transferId);
    return invoiceId ? this.store.get(invoiceId)?.plan?.payee.name : undefined;
  }

  /** The transfer's own labels ∪ the labels chosen on its payment plan ∪ its payee's labels (deduplicated). */
  async effectiveLabels(transferId: string): Promise<string[]> {
    const map = await this.effectiveLabelsMap([transferId]);
    return map.get(transferId) ?? [];
  }

  /** effectiveLabels for many transfers with one read of the labels table. */
  async effectiveLabelsMap(transferIds: readonly string[]): Promise<Map<string, string[]>> {
    const entries = new Map((await this.list()).map((e) => [e.targetId, e.labels]));
    const out = new Map<string, string[]>();
    for (const id of transferIds) {
      const invoiceId = this.store.invoiceForTransfer(id);
      const plan = invoiceId ? this.store.get(invoiceId)?.plan : undefined;
      out.set(
        id,
        normalizeLabels([
          ...(entries.get(id) ?? []),
          ...(plan?.labels ?? []),
          ...(plan ? (entries.get(payeeTarget(plan.payee.name)) ?? []) : []),
        ]),
      );
    }
    return out;
  }
}

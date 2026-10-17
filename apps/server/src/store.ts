// Persistent invoice store on node:sqlite + per-invoice event log with live subscribers.
// Every state change and its `state` event are written in one transaction, so a restart never sees one without
// the other. SSE replay reads the event log from the DB, so it survives restarts too.
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AnalysisReport,
  AppEvent,
  Confirmation,
  ExecutionResult,
  InvoiceRecord,
  InvoiceSourceKind,
  InvoiceState,
  PaymentPlan,
} from 'core';
import { DatabaseSync } from './sqlite.js';

export interface StoredInvoice extends InvoiceRecord {
  kind: InvoiceSourceKind;
  mimeType?: string;
  report?: AnalysisReport;
  /** Built by code from the plan (shown verbatim to the user). */
  confirmationSentence?: string;
}

type Listener = (event: AppEvent) => void;

/** Inline migrations; index i brings the schema from user_version i to i + 1. Append only, never edit. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE invoices (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    filename TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime_type TEXT,
    sha256 TEXT NOT NULL,
    path TEXT NOT NULL,
    confirmation_sentence TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX invoices_state ON invoices(state);
  CREATE TABLE reports (
    invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
    verdict TEXT,
    report_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE plans (
    invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE confirmations (
    invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    confirmed_at TEXT NOT NULL
  );
  CREATE TABLE executions (
    invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    transfer_id TEXT,
    txid TEXT,
    result_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE transfer_links (
    transfer_id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id TEXT,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    event_json TEXT NOT NULL
  );
  CREATE INDEX events_invoice ON events(invoice_id, seq);
  `,
  // 2: PaymentGuard idempotency keys. One row per plan that started executing; deleted only when nothing left the
  // wallet (RELEASE_ON_FAILURE). Survives restarts, so a plan is never paid twice.
  `
  CREATE TABLE guard_claims (
    plan_id TEXT PRIMARY KEY,
    claimed_at TEXT NOT NULL
  );
  CREATE INDEX plans_plan_id ON plans(plan_id);
  `,
  // 3: labels (per transfer, per invoice, or per payee as `payee:<name lowercased>`) and scheduled payment jobs.
  `
  CREATE TABLE labels (
    target_id TEXT PRIMARY KEY,
    labels_json TEXT NOT NULL,
    note TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL,
    run_at TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    result_json TEXT,
    last_error TEXT
  );
  CREATE INDEX jobs_status_run_at ON jobs(status, run_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

interface InvoiceRow {
  id: string;
  state: string;
  filename: string;
  kind: string;
  mime_type: string | null;
  sha256: string;
  path: string;
  confirmation_sentence: string | null;
  created_at: string;
  updated_at: string;
  report_json: string | null;
  plan_json: string | null;
  c_plan_id: string | null;
  confirmed_at: string | null;
  result_json: string | null;
}

const SELECT_INVOICE = `
  SELECT i.*, r.report_json, p.plan_json, c.plan_id AS c_plan_id, c.confirmed_at, e.result_json
  FROM invoices i
  LEFT JOIN reports r ON r.invoice_id = i.id
  LEFT JOIN plans p ON p.invoice_id = i.id
  LEFT JOIN confirmations c ON c.invoice_id = i.id
  LEFT JOIN executions e ON e.invoice_id = i.id`;

function toInvoice(row: InvoiceRow): StoredInvoice {
  return {
    id: row.id,
    state: row.state as InvoiceState,
    filename: row.filename,
    kind: row.kind as InvoiceSourceKind,
    sha256: row.sha256,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    ...(row.confirmation_sentence ? { confirmationSentence: row.confirmation_sentence } : {}),
    ...(row.report_json ? { report: JSON.parse(row.report_json) as AnalysisReport } : {}),
    ...(row.plan_json ? { plan: JSON.parse(row.plan_json) as PaymentPlan } : {}),
    ...(row.c_plan_id && row.confirmed_at
      ? { confirmation: { planId: row.c_plan_id, confirmedAt: row.confirmed_at } satisfies Confirmation }
      : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as ExecutionResult } : {}),
  };
}

export class InvoiceStore {
  readonly db: DatabaseSync;
  private readonly bus = new EventEmitter();
  private readonly now: () => Date;

  /** `path` is a file path (parent dirs are created) or `:memory:`. */
  constructor(path = ':memory:', opts: { now?: () => Date } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = opts.now ?? (() => new Date());
    this.bus.setMaxListeners(0);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    const from = this.schemaVersion;
    if (from > MIGRATIONS.length) {
      throw new Error(
        `The database was created by a newer WiseLedger (schema ${from}, this one knows ${MIGRATIONS.length}). Update the app or use another DB_PATH.`,
      );
    }
    for (let v = from; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  get schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Inserts the invoice and, when given, its first event (UPLOADED) atomically. */
  insert(inv: StoredInvoice, firstEvent?: AppEvent): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO invoices (id, state, filename, kind, mime_type, sha256, path, confirmation_sentence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          inv.id,
          inv.state,
          inv.filename,
          inv.kind,
          inv.mimeType ?? null,
          inv.sha256,
          inv.path,
          inv.confirmationSentence ?? null,
          inv.createdAt,
          inv.updatedAt,
        );
      this.writePatch(inv.id, inv, inv.updatedAt);
      if (firstEvent) this.writeEvent(firstEvent);
    });
    if (firstEvent) this.publish(firstEvent);
  }

  get(id: string): StoredInvoice | undefined {
    const row = this.db.prepare(`${SELECT_INVOICE} WHERE i.id = ?`).get(id) as InvoiceRow | undefined;
    return row ? toInvoice(row) : undefined;
  }

  /** Newest first; optionally only invoices in the given states. */
  list(filter: { states?: readonly InvoiceState[] } = {}): StoredInvoice[] {
    const states = filter.states ?? [];
    const where = states.length ? ` WHERE i.state IN (${states.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(`${SELECT_INVOICE}${where} ORDER BY i.created_at DESC, i.rowid DESC`)
      .all(...states) as unknown as InvoiceRow[];
    return rows.map(toInvoice);
  }

  /** Persists report / plan / confirmation / result / sentence. State changes go through transition(). */
  update(id: string, patch: Partial<Omit<StoredInvoice, 'state'>>): StoredInvoice {
    const at = this.stamp();
    this.tx(() => {
      const res = this.db.prepare('UPDATE invoices SET updated_at = ? WHERE id = ?').run(at, id);
      if (res.changes === 0) throw new Error(`Unknown invoice ${id}`);
      this.writePatch(id, patch, at);
    });
    return this.get(id) as StoredInvoice;
  }

  /**
   * Compare-and-set state change plus its event, in one transaction.
   * Returns undefined (and writes nothing) when the invoice is not in `from` any more.
   */
  transition(id: string, from: InvoiceState, to: InvoiceState, event: AppEvent): StoredInvoice | undefined {
    const ok = this.tx(() => {
      const res = this.db
        .prepare('UPDATE invoices SET state = ?, updated_at = ? WHERE id = ? AND state = ?')
        .run(to, this.stamp(), id, from);
      if (res.changes === 0) return false;
      this.writeEvent(event);
      return true;
    });
    if (!ok) return undefined;
    this.publish(event);
    return this.get(id);
  }

  private writePatch(id: string, patch: Partial<StoredInvoice>, at: string): void {
    if (patch.confirmationSentence !== undefined) {
      this.db.prepare('UPDATE invoices SET confirmation_sentence = ? WHERE id = ?').run(patch.confirmationSentence, id);
    }
    if (patch.report) {
      this.db
        .prepare(
          `INSERT INTO reports (invoice_id, verdict, report_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(invoice_id) DO UPDATE SET verdict = excluded.verdict, report_json = excluded.report_json, updated_at = excluded.updated_at`,
        )
        .run(id, patch.report.verdict, JSON.stringify(patch.report), at);
    }
    if (patch.plan) {
      this.db
        .prepare(
          `INSERT INTO plans (invoice_id, plan_id, plan_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(invoice_id) DO UPDATE SET plan_id = excluded.plan_id, plan_json = excluded.plan_json, updated_at = excluded.updated_at`,
        )
        .run(id, patch.plan.planId, JSON.stringify(patch.plan), at);
    }
    if (patch.confirmation) {
      this.db
        .prepare(
          `INSERT INTO confirmations (invoice_id, plan_id, confirmed_at) VALUES (?, ?, ?)
           ON CONFLICT(invoice_id) DO UPDATE SET plan_id = excluded.plan_id, confirmed_at = excluded.confirmed_at`,
        )
        .run(id, patch.confirmation.planId, patch.confirmation.confirmedAt);
    }
    if (patch.result) {
      const r = patch.result;
      this.db
        .prepare(
          `INSERT INTO executions (invoice_id, plan_id, status, transfer_id, txid, result_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(invoice_id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status, transfer_id = excluded.transfer_id,
             txid = excluded.txid, result_json = excluded.result_json, updated_at = excluded.updated_at`,
        )
        .run(id, r.planId, r.status, r.transferId ?? null, r.txid ?? null, JSON.stringify(r), at);
      if (r.transferId) this.writeLink(r.transferId, id);
    }
  }

  private writeLink(transferId: string, invoiceId: string): void {
    this.db
      .prepare(
        'INSERT INTO transfer_links (transfer_id, invoice_id) VALUES (?, ?) ON CONFLICT(transfer_id) DO UPDATE SET invoice_id = excluded.invoice_id',
      )
      .run(transferId, invoiceId);
  }

  invoiceForTransfer(transferId: string): string | undefined {
    const row = this.db.prepare('SELECT invoice_id FROM transfer_links WHERE transfer_id = ?').get(transferId) as
      | { invoice_id: string }
      | undefined;
    return row?.invoice_id;
  }

  linkTransfer(transferId: string, invoiceId: string): void {
    this.writeLink(transferId, invoiceId);
  }

  private writeEvent(event: AppEvent): void {
    this.db
      .prepare('INSERT INTO events (invoice_id, type, at, event_json) VALUES (?, ?, ?, ?)')
      .run(event.invoiceId ?? null, event.type, event.at, JSON.stringify(event));
    if (event.type === 'transfer' && event.invoiceId) this.writeLink(event.transferId, event.invoiceId);
  }

  private publish(event: AppEvent): void {
    this.bus.emit(event.invoiceId ? `inv:${event.invoiceId}` : 'global', event);
  }

  /** Persists the event, then notifies live subscribers (SSE). */
  appendEvent(event: AppEvent): void {
    this.tx(() => this.writeEvent(event));
    this.publish(event);
  }

  /** Past events of one invoice, oldest first. */
  eventsOf(id: string): AppEvent[] {
    const rows = this.db
      .prepare('SELECT event_json FROM events WHERE invoice_id = ? ORDER BY seq')
      .all(id) as unknown as { event_json: string }[];
    return rows.map((r) => JSON.parse(r.event_json) as AppEvent);
  }

  /** Events without an invoice (e.g. status changes of transfers not linked to an invoice). */
  subscribeGlobal(listener: Listener): () => void {
    this.bus.on('global', listener);
    return () => this.bus.off('global', listener);
  }

  /** Returns an unsubscribe function. */
  subscribe(id: string, listener: Listener): () => void {
    const key = `inv:${id}`;
    this.bus.on(key, listener);
    return () => this.bus.off(key, listener);
  }
}

/** Invoice summary the Treasurer's chat sees (B's `ChatInvoice` in the ai package; structured fields only). */
export interface ChatInvoice {
  invoiceId: string;
  supplier?: string;
  total?: string;
  currency?: string;
  state: InvoiceState;
  /** report.proposedPayment when payable (present and verdict not `block`). */
  payment?: { amount: string; assetId: string };
}

/** Every invoice as a ChatInvoice, newest first. Never includes raw invoice text. */
export function chatInvoices(store: InvoiceStore): ChatInvoice[] {
  return store.list().map((inv) => {
    const ex = inv.report?.extraction;
    const pp = inv.report?.proposedPayment;
    return {
      invoiceId: inv.id,
      state: inv.state,
      ...(ex?.issuer.name ? { supplier: ex.issuer.name } : {}),
      ...(ex?.total ? { total: ex.total } : {}),
      ...(ex?.currency ? { currency: ex.currency } : {}),
      ...(pp && inv.report?.verdict !== 'block' ? { payment: { amount: pp.amount, assetId: pp.assetId } } : {}),
    };
  });
}

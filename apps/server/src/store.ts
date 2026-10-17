// In-memory invoice store + per-invoice event log with live subscribers (SQLite comes later).
import { EventEmitter } from 'node:events';
import type { AnalysisReport, AppEvent, InvoiceRecord, InvoiceSourceKind, InvoiceState } from 'core';

export interface StoredInvoice extends InvoiceRecord {
  kind: InvoiceSourceKind;
  mimeType?: string;
  report?: AnalysisReport;
  /** Built by code from the plan (shown verbatim to the user). */
  confirmationSentence?: string;
}

type Listener = (event: AppEvent) => void;

export class InvoiceStore {
  private readonly invoices = new Map<string, StoredInvoice>();
  private readonly events = new Map<string, AppEvent[]>();
  /** Events not tied to an invoice (agent chat). */
  private readonly globalEvents: AppEvent[] = [];
  private readonly bus = new EventEmitter();
  /** transferId → invoiceId */
  private readonly transferIndex = new Map<string, string>();

  constructor() {
    this.bus.setMaxListeners(0);
  }

  insert(inv: StoredInvoice): void {
    this.invoices.set(inv.id, inv);
    this.events.set(inv.id, []);
  }

  get(id: string): StoredInvoice | undefined {
    return this.invoices.get(id);
  }

  list(): StoredInvoice[] {
    return [...this.invoices.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  update(id: string, patch: Partial<StoredInvoice>): StoredInvoice {
    const cur = this.invoices.get(id);
    if (!cur) throw new Error(`Unknown invoice ${id}`);
    const next: StoredInvoice = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.invoices.set(id, next);
    if (next.result?.transferId) this.transferIndex.set(next.result.transferId, id);
    return next;
  }

  setState(id: string, state: InvoiceState): StoredInvoice {
    return this.update(id, { state });
  }

  invoiceForTransfer(transferId: string): string | undefined {
    return this.transferIndex.get(transferId);
  }

  linkTransfer(transferId: string, invoiceId: string): void {
    this.transferIndex.set(transferId, invoiceId);
  }

  appendEvent(event: AppEvent): void {
    const id = event.invoiceId;
    if (id && this.events.has(id)) this.events.get(id)?.push(event);
    else this.globalEvents.push(event);
    if (event.type === 'transfer' && id) this.transferIndex.set(event.transferId, id);
    this.bus.emit(id ? `inv:${id}` : 'global', event);
  }

  eventsOf(id: string): AppEvent[] {
    return [...(this.events.get(id) ?? [])];
  }

  /** Returns an unsubscribe function. */
  subscribe(id: string, listener: Listener): () => void {
    const key = `inv:${id}`;
    this.bus.on(key, listener);
    return () => this.bus.off(key, listener);
  }
}

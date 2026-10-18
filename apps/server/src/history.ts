// HistoryPort (R4 duplicates, R5 new payee) over the invoice store. Small data: plain scans of store.list().
import type { HistoryMatch, HistoryPort, HistoryQuery, PayeeBookEntry } from 'core';
import type { InvoiceStore, StoredInvoice } from './store.js';

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function rgbInvoiceOf(inv: StoredInvoice): string | undefined {
  return inv.plan?.rgbInvoice ?? inv.report?.extraction.payment.rgbInvoice;
}

export class StoreHistory implements HistoryPort {
  constructor(private readonly store: InvoiceStore) {}

  async seen(by: HistoryQuery): Promise<HistoryMatch[]> {
    const issuer = norm(by.issuer);
    const number = norm(by.number);
    const out: HistoryMatch[] = [];
    for (const inv of this.store.list()) {
      // A failed analysis tells us nothing about the document: never a duplicate source.
      if (inv.id === by.excludeInvoiceId || inv.state === 'FAILED') continue;
      const ex = inv.report?.extraction;
      const stopped = inv.state === 'BLOCKED' || inv.state === 'REJECTED' ? { stopped: true } : {};
      if (issuer && number && ex && norm(ex.issuer.name) === issuer && norm(ex.invoiceNumber) === number) {
        out.push({ invoiceId: inv.id, matchedOn: 'issuer+number', ...stopped });
      } else if (by.sha256 && inv.sha256 === by.sha256) {
        out.push({ invoiceId: inv.id, matchedOn: 'sha256', ...stopped });
      } else if (by.rgbInvoice && rgbInvoiceOf(inv) === by.rgbInvoice) {
        out.push({ invoiceId: inv.id, matchedOn: 'rgbInvoice', ...stopped });
      }
    }
    return out;
  }

  /** One entry per payee name among paid invoices. */
  async payeeBook(): Promise<PayeeBookEntry[]> {
    const book = new Map<string, PayeeBookEntry>();
    for (const inv of this.store.list({ states: ['PAID'] }).reverse()) {
      const name = inv.plan?.payee.name ?? inv.report?.extraction.issuer.name;
      if (!name) continue;
      const key = norm(name);
      const entry = book.get(key) ?? { name, rgbInvoices: [], timesPaid: 0 };
      const vatId = inv.report?.extraction.issuer.vatId;
      if (vatId) entry.vatId = vatId;
      const rgb = rgbInvoiceOf(inv);
      if (rgb && !entry.rgbInvoices.includes(rgb)) entry.rgbInvoices.push(rgb);
      entry.timesPaid += 1;
      entry.lastPaidAt = inv.updatedAt;
      book.set(key, entry);
    }
    return [...book.values()];
  }
}

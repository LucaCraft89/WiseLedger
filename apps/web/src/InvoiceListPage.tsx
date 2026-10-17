import { useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import type { InvoiceState, InvoiceSummaryDto } from './api/contracts.js';
import { formatDate, STATE_LABELS, stateTone, TONE_COLORS, VERDICT_LABELS } from './lib/format.js';
import { filterInvoices, HISTORY_FILTER_LABELS, HISTORY_FILTERS, type HistoryFilter } from './lib/payment.js';

const cell = { padding: '6px 8px', borderBottom: '1px solid var(--wl-c-line)', textAlign: 'left' } as const;

export function InvoiceListPage({ api }: { api: ApiClient }) {
  const [invoices, setInvoices] = useState<InvoiceSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>('all');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.listInvoices();
        if (!alive) return;
        setInvoices(r.invoices);
        setError(null);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Could not load your invoices.');
      }
    };
    void load();
    // Keep statuses fresh while invoices are being checked or paid.
    const timer = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api]);

  const shown = invoices ? filterInvoices(invoices, filter) : [];

  const open = (id: string) => {
    window.location.hash = `#/invoice/${encodeURIComponent(id)}`;
  };

  return (
    <section>
      <h2>Your invoices</h2>
      <nav aria-label="Filter invoices" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {HISTORY_FILTERS.map((f) => {
          const count = invoices ? filterInvoices(invoices, f).length : 0;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              style={{
                padding: '4px 12px',
                borderRadius: 14,
                border: '1px solid var(--wl-c-faint)',
                background: filter === f ? 'var(--wl-c-strong)' : 'var(--wl-c-surface)',
                color: filter === f ? 'var(--wl-c-surface)' : 'var(--wl-c-strong)',
              }}
            >
              {HISTORY_FILTER_LABELS[f]} ({count})
            </button>
          );
        })}
      </nav>
      {error && <p style={{ color: 'var(--wl-c-error)' }}>{error}</p>}
      {!invoices && !error && <p>Loading your invoices…</p>}
      {invoices && invoices.length === 0 && (
        <p>
          No invoices yet — <a href="#/">upload one</a>.
        </p>
      )}
      {invoices && invoices.length > 0 && shown.length === 0 && <p>No invoices here.</p>}
      {shown.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={cell}>File</th>
                <th style={cell}>Supplier</th>
                <th style={cell}>Amount</th>
                <th style={cell}>Status</th>
                <th style={cell}>Our check</th>
                <th style={cell}>Date</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((inv) => (
                <tr key={inv.id} onClick={() => open(inv.id)} style={{ cursor: 'pointer' }}>
                  <td style={cell}>
                    <a href={`#/invoice/${encodeURIComponent(inv.id)}`}>{inv.filename}</a>
                  </td>
                  <td style={cell}>{inv.issuerName ?? '—'}</td>
                  <td style={cell}>{inv.total ? `${inv.total} ${inv.currency ?? ''}`.trim() : '—'}</td>
                  <td style={cell}>
                    <StatusChip state={inv.state} />
                  </td>
                  <td style={cell}>{inv.verdict ? VERDICT_LABELS[inv.verdict] : 'Not checked yet'}</td>
                  <td style={cell}>{formatDate(inv.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ marginTop: 24 }}>
        <a href="#/">Check a new invoice</a>
      </p>
    </section>
  );
}

export function StatusChip({ state }: { state: InvoiceState }) {
  return (
    <span
      style={{ background: TONE_COLORS[stateTone(state)], padding: '2px 8px', borderRadius: 12, whiteSpace: 'nowrap' }}
    >
      {STATE_LABELS[state]}
    </span>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import type { AppEvent, InvoiceDetailResponse, Verdict } from './api/contracts.js';
import { StatusChip } from './InvoiceListPage.js';
import { buildFullTimeline, eventKey, formatAmount, formatDate, stateHistory, TRANSFER_LABELS } from './lib/format.js';
import { ReportView } from './ReportView.js';

const STEP_ICON = { pending: '○', running: '…', done: '✓', error: '✗' } as const;
const STEP_WORD = { pending: 'not started', running: 'in progress', done: 'done', error: 'failed' } as const;

export function InvoicePage({ api, invoiceId }: { api: ApiClient; invoiceId: string }) {
  const [detail, setDetail] = useState<InvoiceDetailResponse | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addEvents = useCallback((incoming: AppEvent[]) => {
    setEvents((prev) => {
      const seen = new Set(prev.map(eventKey));
      const fresh = incoming.filter((e) => !seen.has(eventKey(e)));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await api.getInvoice(invoiceId);
      setDetail(d);
      addEvents(d.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this invoice.');
    }
  }, [api, invoiceId, addEvents]);

  useEffect(() => {
    let unsubscribe = () => {};
    try {
      unsubscribe = api.subscribe(invoiceId, (e) => {
        addEvents([e]);
        // State changes bring new plan / sentence / execution: reload the full record.
        if (e.type === 'state' || e.type === 'report') void refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not follow this invoice.');
    }
    void refresh();
    return unsubscribe;
  }, [api, invoiceId, addEvents, refresh]);

  if (error && !detail) {
    return (
      <section>
        <p style={{ color: '#b00020' }}>{error}</p>
        <a href="#/">Check another invoice</a>
      </section>
    );
  }
  if (!detail) return <p>Loading the invoice…</p>;

  const { invoice, report, plan, confirmationSentence, execution } = detail;
  const timeline = buildFullTimeline(events);
  const history = stateHistory(events);
  const transfers = events.filter((e) => e.type === 'transfer');
  const lastTransfer = transfers[transfers.length - 1];
  const errors = events.filter((e) => e.type === 'error');

  return (
    <section>
      <h2>{invoice.filename}</h2>
      <p>
        Status: <StatusChip state={invoice.state} />
      </p>

      <h3>Progress</h3>
      <ol>
        {timeline.map((s) => (
          <li
            key={s.stage}
            data-status={s.status}
            style={{ color: s.status === 'pending' ? '#888' : s.status === 'error' ? '#b00020' : undefined }}
          >
            {STEP_ICON[s.status]} {s.label} <small>({STEP_WORD[s.status]})</small>
            {s.message && <div style={{ fontSize: '0.9em' }}>{s.message}</div>}
          </li>
        ))}
        {transfers.length > 0 && lastTransfer?.type === 'transfer' && <li>{TRANSFER_LABELS[lastTransfer.status]}</li>}
      </ol>

      {history.length > 0 && (
        <details>
          <summary>Status history</summary>
          <ul>
            {history.map((h) => (
              <li key={`${h.at}-${h.label}`}>
                {formatDate(h.at)}: {h.label}
              </li>
            ))}
          </ul>
        </details>
      )}

      {report && <ReportView report={report} />}

      {errors.map((e) => (e.type === 'error' ? <ErrorLine key={eventKey(e)} message={e.message} /> : null))}
      {error && <ErrorLine message={error} />}

      {invoice.state === 'AWAITING_CONFIRMATION' && plan && report && (
        <ConfirmBox
          verdict={report.verdict}
          sentence={
            confirmationSentence ??
            `Pay ${formatAmount(plan.amount, 6)} TUSDT to ${plan.payee.name}${plan.executeAt === 'now' ? ', now' : ` on ${plan.executeAt}`}. Confirm?`
          }
          onConfirm={async (override) => {
            setError(null);
            try {
              await api.confirm(invoiceId, { planId: plan.planId, override });
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Confirmation failed.');
            }
          }}
          onReject={async () => {
            setError(null);
            try {
              await api.reject(invoiceId, 'Rejected by the user');
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not reject the invoice.');
            }
          }}
        />
      )}

      {invoice.state === 'BLOCKED' && (
        <p style={{ background: '#f8d7da', padding: 12 }}>
          We stopped this payment. You do not need to do anything. If you think this is a mistake, contact the supplier
          using a phone number you already know, not the one on the invoice.
        </p>
      )}

      <FinalStatus detail={detail} executionTransferId={execution?.transferId ?? lastTransferId(events)} />

      <p style={{ marginTop: 32 }}>
        <a href="#/">Check another invoice</a> · <a href="#/invoices">All invoices</a>
      </p>
    </section>
  );
}

function lastTransferId(events: AppEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'transfer') return e.transferId;
  }
  return undefined;
}

function ErrorLine({ message }: { message: string }) {
  return <p style={{ color: '#b00020' }}>{message}</p>;
}

function ConfirmBox(props: {
  verdict: Verdict;
  sentence: string;
  onConfirm: (override: boolean | undefined) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const needsTick = props.verdict === 'review';
  const canConfirm = props.verdict !== 'block' && (!needsTick || checked) && !busy;
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ border: '2px solid #333', padding: 16, marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Do you want to pay?</h3>
      <p style={{ fontSize: '1.1em' }}>{props.sentence}</p>
      {needsTick && (
        <label style={{ display: 'block', marginBottom: 12 }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I checked the
          warnings and I still want to pay
        </label>
      )}
      <button
        type="button"
        disabled={!canConfirm}
        onClick={run(() => props.onConfirm(needsTick ? true : undefined))}
        style={{ fontSize: '1.1em', padding: '8px 20px', marginRight: 12 }}
      >
        Confirm and pay
      </button>
      <button type="button" disabled={busy} onClick={run(props.onReject)} style={{ padding: '8px 20px' }}>
        Do not pay
      </button>
    </div>
  );
}

function FinalStatus({ detail, executionTransferId }: { detail: InvoiceDetailResponse; executionTransferId?: string }) {
  const { state } = detail.invoice;
  const ex = detail.execution;
  if (state === 'PAID') {
    return (
      <div style={{ background: '#d4edda', padding: 12 }}>
        <strong>Paid.</strong> The payment was sent with RGB.
        {executionTransferId && <div>Transfer ID: {executionTransferId}</div>}
        {ex?.txid && <div>Bitcoin transaction: {ex.txid}</div>}
      </div>
    );
  }
  if (state === 'SCHEDULED') return <p style={{ background: '#d1ecf1', padding: 12 }}>The payment is scheduled.</p>;
  if (state === 'REJECTED')
    return <p style={{ background: '#e2e3e5', padding: 12 }}>You chose not to pay. Nothing was sent.</p>;
  if (state === 'FAILED') {
    return (
      <p style={{ background: '#f8d7da', padding: 12 }}>
        The payment did not go through. {ex?.error?.message ?? ''} No money was retried automatically.
      </p>
    );
  }
  return null;
}

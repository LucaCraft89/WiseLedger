import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import type { AppEvent, InvoiceDetailResponse, PaymentPlan } from './api/contracts.js';
import { ConfirmDialog, PaymentProgressView } from './ConfirmDialog.js';
import { StatusChip } from './InvoiceListPage.js';
import {
  type AssetMeta,
  dialogSentence,
  findAsset,
  type PaymentProgress,
  paidSentence,
  paymentProgress,
  showsProgress,
} from './lib/confirm.js';
import { buildFullTimeline, eventKey, formatDate, stateHistory } from './lib/format.js';
import { ReportView } from './ReportView.js';

const STEP_ICON = { pending: '○', running: '…', done: '✓', error: '✗' } as const;
const STEP_WORD = { pending: 'not started', running: 'in progress', done: 'done', error: 'failed' } as const;

export function InvoicePage({ api, invoiceId }: { api: ApiClient; invoiceId: string }) {
  const [detail, setDetail] = useState<InvoiceDetailResponse | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetMeta[]>([]);

  useEffect(() => {
    // Ticker and precision for amounts; without it the sentence falls back to base units or the server's text.
    api.wallet().then(
      (w) => setAssets(w.assets),
      () => setAssets([]),
    );
  }, [api]);

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

      {(invoice.state === 'AWAITING_CONFIRMATION' || invoice.state === 'BLOCKED') && report && (
        <ConfirmDialog
          verdict={invoice.state === 'BLOCKED' ? 'block' : report.verdict}
          flags={report.flags}
          sentence={plan ? sentenceFor(plan, assets, confirmationSentence) : undefined}
          onConfirm={async (override) => {
            if (!plan) return;
            await api.confirm(invoiceId, { planId: plan.planId, override });
            await refresh();
          }}
          onReject={async (reason) => {
            await api.reject(invoiceId, reason);
            await refresh();
          }}
        />
      )}

      {invoice.state === 'BLOCKED' && (
        <p style={{ background: '#f8d7da', padding: 12 }}>
          We stopped this payment. You do not need to do anything. If you think this is a mistake, contact the supplier
          using a phone number you already know, not the one on the invoice.
        </p>
      )}

      {showsProgress(invoice.state, events) && (
        <PaymentProgressView progress={paymentProgress(invoice.state, events, execution)} />
      )}

      <FinalStatus detail={detail} progress={paymentProgress(invoice.state, events, execution)} assets={assets} />

      <p style={{ marginTop: 32 }}>
        <a href="#/">Check another invoice</a> · <a href="#/invoices">All invoices</a>
      </p>
    </section>
  );
}

function ErrorLine({ message }: { message: string }) {
  return <p style={{ color: '#b00020' }}>{message}</p>;
}

/** Prefer the sentence built here by code; fall back to the server's only when the asset is unknown. */
function sentenceFor(plan: PaymentPlan, assets: AssetMeta[], serverSentence: string | undefined): string {
  if (!findAsset(plan.assetId, assets) && serverSentence) return serverSentence;
  return dialogSentence(plan, assets);
}

function FinalStatus({
  detail,
  progress,
  assets,
}: {
  detail: InvoiceDetailResponse;
  progress: PaymentProgress;
  assets: AssetMeta[];
}) {
  const { state } = detail.invoice;
  const { plan } = detail;
  if (state === 'PAID') {
    return (
      <div style={{ background: '#d4edda', padding: 12, marginTop: 16 }} data-testid="paid-card">
        <strong style={{ fontSize: '1.3em' }}>Paid ✓</strong>
        {plan && <div>You paid {paidSentence(plan, assets)}.</div>}
        {progress.transferId && <div>Transfer ID: {progress.transferId}</div>}
        {progress.txid && <div>Bitcoin transaction: {progress.txid}</div>}
      </div>
    );
  }
  if (state === 'SCHEDULED') return <p style={{ background: '#d1ecf1', padding: 12 }}>The payment is scheduled.</p>;
  if (state === 'REJECTED')
    return <p style={{ background: '#e2e3e5', padding: 12 }}>You chose not to pay this invoice. Nothing was sent.</p>;
  return null;
}

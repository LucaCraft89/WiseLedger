import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import {
  type AppEvent,
  type InvoiceDetailResponse,
  isLightningInvoice,
  type PaymentPlan,
  type Stage,
} from './api/contracts.js';
import { ConfirmDialog, PaymentProgressView } from './ConfirmDialog.js';
import { StatusChip } from './InvoiceListPage.js';
import { aiRunStats, recordAiRun } from './lib/ai-stats.js';
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
import { LIVE_STAGE_TEXT, liveAiView, mergeEvents, toolCallParts } from './lib/live.js';
import { FailureCard, ResultCard } from './PaymentCards.js';
import { ReportView } from './ReportView.js';
import { errorText, useToast } from './ui.js';

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

  const toast = useToast();

  const addEvents = useCallback((incoming: AppEvent[], live = false) => {
    setEvents((prev) => mergeEvents(prev, incoming, live));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await api.getInvoice(invoiceId);
      setDetail(d);
      addEvents(d.events);
    } catch (err) {
      const msg = errorText(err, 'Could not load this invoice.');
      setError(msg);
      toast(msg, 'error');
    }
  }, [api, invoiceId, addEvents, toast]);

  useEffect(() => {
    let unsubscribe = () => {};
    try {
      unsubscribe = api.subscribe(invoiceId, (e) => {
        addEvents([e], true);
        // State changes bring new plan / sentence / execution: reload the full record.
        if (e.type === 'state' || e.type === 'report') void refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not follow this invoice.');
    }
    void refresh();
    return unsubscribe;
  }, [api, invoiceId, addEvents, refresh]);

  // Speed of the last analysis, for the "Local AI" panel in Settings (memory only).
  const report = detail?.report;
  useEffect(() => {
    recordAiRun(aiRunStats(events, report));
  }, [events, report]);

  if (error && !detail) {
    return (
      <section>
        <p style={{ color: 'var(--wl-c-error)' }}>{error}</p>
        <a href="#/">Check another invoice</a>
      </section>
    );
  }
  if (!detail) return <p>Loading the invoice…</p>;

  const { invoice, plan, confirmationSentence, execution } = detail;
  const timeline = buildFullTimeline(events);
  const history = stateHistory(events);
  const progress = paymentProgress(invoice.state, events, execution, isLightningInvoice(plan?.rgbInvoice));
  // A failed payment gets its own card with the error in plain words.
  const errors = progress.failed ? [] : events.filter((e) => e.type === 'error');
  const live = liveAiView(events);
  const toolCalls = events.filter((e) => e.type === 'toolCall');

  // Analysis steps, live AI text, tool calls and status history: on top while the check runs, folded away at the
  // bottom once the report is there (the answer comes first).
  const steps = (
    <>
      <h3>Progress</h3>
      <ol>
        {timeline.map((s) => (
          <li
            key={s.stage}
            data-status={s.status}
            style={{
              color:
                s.status === 'pending' ? 'var(--wl-c-faint)' : s.status === 'error' ? 'var(--wl-c-error)' : undefined,
            }}
          >
            {STEP_ICON[s.status]} {s.label} <small>({STEP_WORD[s.status]})</small>
            {s.message && <div style={{ fontSize: '0.9em' }}>{s.message}</div>}
          </li>
        ))}
      </ol>

      <LiveAiPanel stage={live.stage} text={live.text} />

      {toolCalls.length > 0 && (
        <div data-testid="tool-calls">
          <h3>What the Treasurer did</h3>
          <ul style={{ overflowWrap: 'anywhere' }}>
            {toolCalls.map((e) => {
              if (e.type !== 'toolCall') return null;
              const p = toolCallParts(e);
              return (
                <li key={eventKey(e)}>
                  {p.text}{' '}
                  <small>
                    (tool: <code>{p.tech}</code>)
                  </small>
                </li>
              );
            })}
          </ul>
        </div>
      )}

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
    </>
  );

  return (
    <section>
      <h2>{invoice.filename}</h2>
      <p>
        Status: <StatusChip state={invoice.state} />
      </p>

      {!report && steps}

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
        <p style={{ background: 'var(--wl-c-error-bg)', padding: 12 }}>
          We stopped this payment. You do not need to do anything. If you think this is a mistake, contact the supplier
          using a phone number you already know, not the one on the invoice.
        </p>
      )}

      {showsProgress(invoice.state, events) && <PaymentProgressView progress={progress} />}

      <FinalStatus
        detail={detail}
        progress={progress}
        assets={assets}
        onRetry={async () => {
          if (!plan) return;
          await api.confirm(invoiceId, {
            planId: plan.planId,
            override: report?.verdict === 'review' ? true : undefined,
          });
          await refresh();
        }}
      />

      {report && (
        <details style={{ marginTop: 24 }} data-testid="how-we-checked">
          <summary>How we checked it (steps, AI activity, status history)</summary>
          {steps}
        </details>
      )}

      <p style={{ marginTop: 32 }}>
        <a href="#/">Check another invoice</a> · <a href="#/invoices">All invoices</a>
      </p>
    </section>
  );
}

/** While the Analyst works: the current step in plain words and the live text from the local model. */
function LiveAiPanel({ stage, text }: { stage?: Stage; text: string }) {
  const info = stage ? LIVE_STAGE_TEXT[stage] : undefined;
  if (!info) return null;
  return (
    <div
      data-testid="live-ai"
      aria-live="polite"
      style={{
        border: '1px solid var(--wl-c-note-line)',
        background: 'var(--wl-c-note-bg)',
        borderRadius: 6,
        padding: 12,
        margin: '12px 0',
      }}
    >
      <strong>{info.title}</strong>
      <div>{info.detail}</div>
      <div style={{ fontSize: '0.85em', color: 'var(--wl-c-muted)' }}>
        AI running on this computer: your invoice never leaves it.
      </div>
      <pre
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: '0.85em',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: 'var(--wl-c-surface)',
          border: '1px solid var(--wl-c-line)',
          padding: 8,
          margin: '8px 0 0',
          minHeight: '3em',
          maxHeight: '10em',
          overflow: 'auto',
        }}
      >
        {text || '…'}
      </pre>
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return <p style={{ color: 'var(--wl-c-error)' }}>{message}</p>;
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
  onRetry,
}: {
  detail: InvoiceDetailResponse;
  progress: PaymentProgress;
  assets: AssetMeta[];
  onRetry: () => Promise<void>;
}) {
  const { state } = detail.invoice;
  const { plan } = detail;
  if (state === 'PAID') {
    return (
      <ResultCard
        sentence={plan ? paidSentence(plan, assets) : undefined}
        transferId={progress.transferId}
        txid={progress.txid}
        {...(progress.paymentHash ? { paymentHash: progress.paymentHash } : {})}
        lightning={isLightningInvoice(plan?.rgbInvoice)}
      />
    );
  }
  if (progress.failed) {
    return (
      <FailureCard
        code={progress.errorCode}
        message={progress.errorMessage}
        transferId={progress.transferId}
        onRetry={plan ? onRetry : undefined}
      />
    );
  }
  if (state === 'SCHEDULED')
    return <p style={{ background: 'var(--wl-c-sched-bg)', padding: 12 }}>The payment is scheduled.</p>;
  if (state === 'REJECTED')
    return (
      <p style={{ background: 'var(--wl-c-neutral-bg)', padding: 12 }}>
        You chose not to pay this invoice. Nothing was sent.
      </p>
    );
  return null;
}

import { useCallback, useState } from 'react';
import type { ApiClient } from './api/client.js';
import type { Job } from './api/contracts.js';
import { formatDate } from './lib/format.js';
import { canCancelJob, JOB_STATUS_COLORS, JOB_STATUS_WORDS, sortJobs } from './lib/ledger.js';
import { explorerTxUrl, shortId } from './lib/payment.js';
import { EXPLORER_BASE } from './PaymentCards.js';
import { Empty, ErrorBox, errorText, Loading, useLoad, useToast } from './ui.js';

const row = { border: '1px solid var(--wl-c-line)', borderRadius: 6, padding: 12, marginBottom: 8 } as const;

/** #/schedule: scheduled payments, with Cancel for the ones still waiting. */
export function SchedulePage({ api }: { api: ApiClient }) {
  const load = useCallback(async () => sortJobs((await api.schedule()).jobs), [api]);
  const { data, error, loading, reload } = useLoad(load);

  return (
    <section>
      <h2>Scheduled payments</h2>
      <p>
        Payments you confirmed for a later date. They run on this computer, so keep WiseLedger open.{' '}
        <button type="button" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </p>
      {error ? <ErrorBox error={error} retry={reload} /> : null}
      {loading && !data ? <Loading text="Loading scheduled payments…" /> : null}
      {data && data.length === 0 && (
        <Empty text="No scheduled payments. Ask the Treasurer, e.g. “Pay the Acme invoice on Friday”." />
      )}
      {data?.map((job) => (
        <JobRow key={job.jobId} api={api} job={job} onChanged={reload} />
      ))}
    </section>
  );
}

export function JobRow({ api, job, onChanged }: { api: ApiClient; job: Job; onChanged: () => void }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function cancel() {
    setBusy(true);
    try {
      const res = await api.cancelJob(job.jobId);
      if (res.ok) toast('Scheduled payment cancelled. Nothing was paid.', 'success');
      else toast('This payment can no longer be cancelled (it already ran or was cancelled).', 'error');
      onChanged();
    } catch (err) {
      toast(errorText(err, 'Could not cancel the payment.'), 'error');
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }

  return (
    <div style={row} data-testid="job-row">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong>{formatDate(job.runAt)}</strong>
        <span style={{ background: JOB_STATUS_COLORS[job.status], borderRadius: 12, padding: '0 8px' }}>
          {JOB_STATUS_WORDS[job.status]}
        </span>
        <a href={`#/invoice/${encodeURIComponent(job.invoiceId)}`}>Open the invoice</a>
      </div>
      {job.result?.transferId && (
        <p style={{ margin: '4px 0 0' }} data-testid="job-proof">
          Transfer ID: <code title={job.result.transferId}>{shortId(job.result.transferId)}</code>
          {job.result.txid && (
            <>
              {' · '}Bitcoin transaction: <code title={job.result.txid}>{shortId(job.result.txid)}</code>{' '}
              <a href={explorerTxUrl(job.result.txid, EXPLORER_BASE)} target="_blank" rel="noopener noreferrer">
                View on the block explorer
              </a>
            </>
          )}
        </p>
      )}
      {job.lastError && <p style={{ color: 'var(--wl-c-error)', margin: '4px 0 0' }}>Problem: {job.lastError}</p>}
      {canCancelJob(job) &&
        (asking ? (
          <p style={{ margin: '8px 0 0' }}>
            Are you sure? The payment will not happen.{' '}
            <button type="button" onClick={() => void cancel()} disabled={busy}>
              {busy ? 'Cancelling…' : 'Yes, cancel it'}
            </button>{' '}
            <button type="button" onClick={() => setAsking(false)} disabled={busy}>
              Keep it
            </button>
          </p>
        ) : (
          <p style={{ margin: '8px 0 0' }}>
            <button type="button" onClick={() => setAsking(true)}>
              Cancel
            </button>
          </p>
        ))}
    </div>
  );
}

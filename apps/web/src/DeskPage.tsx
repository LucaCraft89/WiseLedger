import { type DragEvent, useCallback, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { OWL_NAME } from './api/contracts.js';
import { balanceSentence, greeting, latelyHref } from './lib/desk.js';
import { shortDate } from './lib/format.js';
import { Empty, ErrorBox, errorText, Loading, OwlChip, useLoad } from './ui.js';

/** Pay door: drop an invoice right on the Desk; I start reading it and the invoice page opens. */
function PayDoor({ api }: { api: ApiClient }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  async function take(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.createInvoice({ file });
      window.location.hash = `#/invoice/${encodeURIComponent(res.invoiceId)}`;
    } catch (err) {
      setError(errorText(err, 'I could not take that invoice. Check the file and try again.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wl-door">
      <strong>Pay an invoice</strong>
      <label
        className={`wl-dropzone${over ? ' wl-dropzone-over' : ''}`}
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files?.[0]);
        }}
      >
        <span>
          {busy
            ? 'Reading your invoice… (about 30 seconds on this computer)'
            : 'Drop the invoice here, or click to choose it'}
        </span>
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.xml"
          className="wl-visually-hidden"
          disabled={busy}
          onChange={(e) => void take(e.target.files?.[0])}
        />
      </label>
      {error && (
        <p role="alert" style={{ color: 'var(--wl-c-error)', margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** `#/`: the Money Desk. What needs the user today, from real data only. */
export function DeskPage({ api }: { api: ApiClient }) {
  const load = useCallback(() => api.desk(), [api]);
  const { data, error, loading, reload } = useLoad(load);

  return (
    <section>
      <div className="wl-desk-hello">
        <OwlChip mood={data && data.greetingCounts.needsYou > 0 ? 'thinking' : 'all_good'} size={56} />
      </div>
      {error ? (
        <ErrorBox
          error={errorText(
            error,
            `${OWL_NAME} could not open the desk. Check that the server is running, then try again.`,
          )}
          retry={reload}
        />
      ) : null}
      {loading && !data ? <Loading text="Opening your desk… (a few seconds)" /> : null}
      {data && (
        <>
          <h2 style={{ margin: '0 0 4px' }}>{greeting(data.greetingCounts.needsYou)}</h2>
          <p style={{ marginTop: 0, color: 'var(--wl-c-muted)' }}>{balanceSentence(data)}</p>

          <div className="wl-doors">
            <PayDoor api={api} />
            <a className="wl-door" href="#/get-paid">
              <strong>Get paid</strong>
              <span>Send a payment request to someone who owes you.</span>
            </a>
          </div>

          <h3>Needs you</h3>
          {data.needsYou.length === 0 ? (
            <Empty text="Nothing needs you right now. I will tell you here when something does." />
          ) : (
            <ul className="wl-list" aria-label="Needs you">
              {data.needsYou.map((n) => (
                <li key={`${n.kind}-${n.id}`}>
                  <span>{n.title}</span>
                  <a href={n.action.href} className="wl-secondary">
                    {n.action.label}
                  </a>
                </li>
              ))}
            </ul>
          )}

          <h3>Lately</h3>
          {data.lately.length === 0 ? (
            <Empty text="Nothing yet. Pay or send your first invoice." />
          ) : (
            <ul className="wl-list" aria-label="Lately">
              {data.lately.map((l) => (
                <li key={`${l.kind}-${l.id}`}>
                  <a href={latelyHref(l)}>{l.title}</a>
                  <small style={{ color: 'var(--wl-c-muted)' }}>{shortDate(l.at)}</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

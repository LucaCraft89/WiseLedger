import { useState } from 'react';
import type { RiskFlag, Verdict } from './api/contracts.js';
import { FlagList } from './FlagCard.js';
import { BLOCK_EXPLANATION, confirmGate, gateHint, type PaymentProgress, REVIEW_TICK_LABEL } from './lib/confirm.js';

/**
 * "Confirm payment" panel: flags first, then the sentence built by code.
 * block → confirm disabled with an explanation; review → tick box required (sends override: true).
 */
export function ConfirmDialog(props: {
  verdict: Verdict;
  flags: readonly RiskFlag[];
  /** Undefined when no payment was prepared (blocked invoices). */
  sentence?: string;
  onConfirm: (override: true | undefined) => Promise<void>;
  onReject: (reason: string | undefined) => Promise<void>;
}) {
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const gate = confirmGate(props.verdict, ticked);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      role="dialog"
      aria-labelledby="confirm-title"
      style={{ border: '2px solid #333', borderRadius: 6, padding: 16, marginTop: 16 }}
    >
      <h3 id="confirm-title" style={{ marginTop: 0 }}>
        Confirm payment
      </h3>

      {props.flags.length > 0 && <FlagList flags={props.flags} />}

      {props.sentence && <p style={{ fontSize: '1.15em', fontWeight: 600 }}>{props.sentence}</p>}

      {props.verdict === 'block' && (
        <p style={{ background: '#f8d7da', padding: 10 }} data-testid="block-explanation">
          {BLOCK_EXPLANATION}
        </p>
      )}

      {props.verdict === 'review' && (
        <label style={{ display: 'block', marginBottom: 12 }}>
          <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} /> {REVIEW_TICK_LABEL}
        </label>
      )}

      {error && (
        <p role="alert" style={{ color: '#b00020' }}>
          {error}
        </p>
      )}

      {rejecting ? (
        <div>
          <label style={{ display: 'block', marginBottom: 8 }}>
            Why are you not paying? (optional)
            <textarea
              value={reason}
              maxLength={500}
              rows={2}
              onChange={(e) => setReason(e.target.value)}
              style={{ display: 'block', width: '100%', marginTop: 4 }}
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={run(() => props.onReject(reason.trim() || undefined))}
            style={{ padding: '8px 20px', marginRight: 12 }}
          >
            Yes, do not pay
          </button>
          <button type="button" disabled={busy} onClick={() => setRejecting(false)} style={{ padding: '8px 20px' }}>
            Go back
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            disabled={!gate.canConfirm || busy || !props.sentence}
            onClick={run(() => props.onConfirm(gate.override))}
            style={{ fontSize: '1.1em', padding: '8px 20px', marginRight: 12 }}
          >
            Confirm and pay
          </button>
          <button type="button" disabled={busy} onClick={() => setRejecting(true)} style={{ padding: '8px 20px' }}>
            Do not pay
          </button>
          <p data-testid="gate-hint" style={{ margin: '8px 0 0', fontSize: '0.95em' }}>
            {gateHint(props.verdict, ticked)}
          </p>
        </div>
      )}
    </section>
  );
}

const PROGRESS_ICON = { pending: '○', running: '…', done: '✓' } as const;

/** The 4-step payment stepper (failures get their own card). */
export function PaymentProgressView({ progress }: { progress: PaymentProgress }) {
  return (
    <div style={{ marginTop: 16 }}>
      <h3>Payment</h3>
      <ol style={{ listStyle: 'none', padding: 0 }}>
        {progress.steps.map((s) => (
          <li key={s.label} data-status={s.status} style={{ color: s.status === 'pending' ? '#888' : undefined }}>
            {PROGRESS_ICON[s.status]} {s.label}
            {s.status === 'running' && <small> (in progress)</small>}
          </li>
        ))}
      </ol>
    </div>
  );
}

import { useState } from 'react';
import type { RiskFlag, Verdict } from './api/contracts.js';
import {
  assetIdHint,
  BLOCK_EXPLANATION,
  confirmGate,
  gateHint,
  type PaymentProgress,
  REVIEW_TICK_LABEL,
} from './lib/confirm.js';
import { toBaseUnits } from './lib/live.js';
import { splitFlags } from './lib/payment.js';

/**
 * "Confirm payment" panel: flags first, then the sentence built by code.
 * block → explanation and one "close without paying" button (no pay button); review → tick box required (sends override: true).
 */
export function ConfirmDialog(props: {
  verdict: Verdict;
  flags: readonly RiskFlag[];
  /** Undefined when no payment was prepared (blocked invoices). */
  sentence?: string;
  onConfirm: (override: true | undefined) => Promise<void>;
  onReject: (reason: string | undefined) => Promise<void>;
  /** Open-amount payment request: ask for the amount first (the server checks it and builds the sentence). */
  amount?: { ticker: string; precision: number; onSet: (baseUnits: string) => Promise<void> };
}) {
  const [typed, setTyped] = useState('');
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Info flags are calm notes, not points to check.
  const { alerts } = splitFlags(props.flags);
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
      style={{ border: '2px solid var(--wl-c-strong)', borderRadius: 6, padding: 16, marginTop: 16 }}
    >
      <h3 id="confirm-title" style={{ marginTop: 0 }}>
        Confirm payment
      </h3>

      {/* The flag cards are already shown in "Checks" above: one line here, so nothing is read twice. */}
      {alerts.length > 0 && props.verdict !== 'block' && (
        <p data-testid="flags-pointer">
          {alerts.length === 1 ? 'There is 1 point' : `There are ${alerts.length} points`} to check in “Checks” above.
          Read {alerts.length === 1 ? 'it' : 'them'} before you pay.
        </p>
      )}

      {props.amount && props.verdict !== 'block' && (
        <form
          data-testid="amount-form"
          onSubmit={(e) => {
            e.preventDefault();
            const a = props.amount;
            if (!a) return;
            const base = toBaseUnits(typed, a.precision);
            if (!base.ok) return setError(base.error);
            if (!base.value) return setError('Type the amount to pay.');
            const value = base.value;
            void run(() => a.onSet(value))();
          }}
          style={{ marginBottom: 12 }}
        >
          <label style={{ display: 'block', marginBottom: 8 }}>
            {props.sentence ? 'Change the amount' : 'This request leaves the amount to you. How much do you pay?'}{' '}
            <input
              inputMode="decimal"
              placeholder="e.g. 10.00"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{ width: 120 }}
            />{' '}
            {props.amount.ticker}
          </label>
          <button type="submit" className={props.sentence ? 'wl-secondary' : undefined} disabled={busy}>
            Use this amount
          </button>
        </form>
      )}

      {props.sentence && <p style={{ fontSize: '1.15em', fontWeight: 600, marginBottom: 4 }}>{props.sentence}</p>}
      {assetIdHint(props.sentence) && (
        <p data-testid="asset-id-hint" style={{ fontSize: '0.9em', marginTop: 0 }}>
          {assetIdHint(props.sentence)}
        </p>
      )}

      {props.verdict === 'block' && (
        <p style={{ background: 'var(--wl-c-error-bg)', padding: 10 }} data-testid="block-explanation">
          {BLOCK_EXPLANATION}
        </p>
      )}

      {props.verdict === 'review' && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={ticked}
            onChange={(e) => setTicked(e.target.checked)}
            style={{ width: 'auto', margin: 0 }}
          />
          {REVIEW_TICK_LABEL}
        </label>
      )}

      {error && (
        <p role="alert" style={{ color: 'var(--wl-c-error)' }}>
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
          <button
            className="wl-secondary"
            type="button"
            disabled={busy}
            onClick={() => setRejecting(false)}
            style={{ padding: '8px 20px' }}
          >
            Go back
          </button>
        </div>
      ) : props.verdict === 'block' ? (
        <button type="button" disabled={busy} onClick={() => setRejecting(true)} style={{ padding: '8px 20px' }}>
          Close this invoice without paying
        </button>
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
          <button
            className="wl-secondary"
            type="button"
            disabled={busy}
            onClick={() => setRejecting(true)}
            style={{ padding: '8px 20px' }}
          >
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
          <li
            key={s.label}
            data-status={s.status}
            style={{ color: s.status === 'pending' ? 'var(--wl-c-faint)' : undefined }}
          >
            {PROGRESS_ICON[s.status]} {s.label}
            {s.status === 'running' && <small> (in progress)</small>}
          </li>
        ))}
      </ol>
    </div>
  );
}

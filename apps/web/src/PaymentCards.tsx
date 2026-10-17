import { useState } from 'react';
import { canRetry, DEFAULT_EXPLORER_URL, errorWords, explorerTxUrl, shortId } from './lib/payment.js';
import { CopyButton, errorText } from './ui.js';

/** From the root .env (RGB_EXPLORER_URL) via vite.config.ts; Mutinynet by default. */
export const EXPLORER_BASE: string = import.meta.env.VITE_RGB_EXPLORER_URL || DEFAULT_EXPLORER_URL;

/**
 * Paid: what was paid, the transfer ID and the Bitcoin transaction with a link to the explorer. A Lightning payment
 * has no Bitcoin transaction: the card shows its payment hash instead.
 */
export function ResultCard({
  sentence,
  transferId,
  txid,
  paymentHash,
  lightning = false,
}: {
  sentence?: string;
  transferId?: string;
  txid?: string;
  paymentHash?: string;
  lightning?: boolean;
}) {
  return (
    <div
      data-testid="paid-card"
      style={{
        background: 'var(--wl-c-ok-bg)',
        borderLeft: '6px solid var(--wl-c-ok-line)',
        borderRadius: 4,
        padding: 12,
        marginTop: 16,
      }}
    >
      <strong style={{ fontSize: '1.3em' }}>Paid ✓</strong>
      {sentence && <div>You paid {sentence}.</div>}
      {transferId && (
        <div style={{ marginTop: 6 }}>
          Transfer ID: <code title={transferId}>{shortId(transferId)}</code>{' '}
          <CopyButton value={transferId} what="Transfer ID" />
        </div>
      )}
      {lightning ? (
        paymentHash ? (
          <div style={{ marginTop: 6 }} data-testid="payment-hash">
            Lightning payment hash: <code title={paymentHash}>{shortId(paymentHash)}</code>{' '}
            <CopyButton value={paymentHash} what="Payment hash" />
            <div style={{ fontSize: '0.9em' }}>
              Paid over Lightning: no Bitcoin transaction is needed, the supplier received it at once.
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 6, fontSize: '0.9em' }}>
            Paid over Lightning: the payment hash will appear here once known.
          </div>
        )
      ) : txid ? (
        <div style={{ marginTop: 6 }}>
          Bitcoin transaction: <code title={txid}>{shortId(txid)}</code>{' '}
          <CopyButton value={txid} what="Transaction ID" />{' '}
          <a href={explorerTxUrl(txid, EXPLORER_BASE)} target="_blank" rel="noopener noreferrer">
            View on the block explorer
          </a>
        </div>
      ) : (
        <div style={{ marginTop: 6, fontSize: '0.9em' }}>The Bitcoin transaction ID will appear here once known.</div>
      )}
    </div>
  );
}

/**
 * Failed: the typed error in plain words. "Try again" only when it cannot pay twice
 * (see canRetry); never after SubmitTimeout or when a transfer exists.
 */
export function FailureCard({
  code,
  message,
  transferId,
  onRetry,
}: {
  code?: string;
  message?: string;
  transferId?: string;
  onRetry?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const safe = canRetry(code, transferId) && !!onRetry;
  const unsure = code === 'SubmitTimeout' || !!transferId;
  return (
    <div
      data-testid="failure-card"
      role="alert"
      style={{
        background: 'var(--wl-c-error-bg)',
        borderLeft: '6px solid var(--wl-c-danger)',
        borderRadius: 4,
        padding: 12,
        marginTop: 16,
      }}
    >
      <strong style={{ fontSize: '1.2em' }}>{unsure ? 'We are not sure the payment went through' : 'Not paid'}</strong>
      <div>{errorWords(code, message)}</div>
      {message && message !== errorWords(code, message) && (
        <div style={{ fontSize: '0.85em', color: 'var(--wl-c-muted)' }}>Details: {message}</div>
      )}
      {transferId && (
        <div style={{ fontSize: '0.9em', marginTop: 4 }}>
          Transfer ID: <code title={transferId}>{shortId(transferId)}</code>{' '}
          <CopyButton value={transferId} what="Transfer ID" />
        </div>
      )}
      {safe ? (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onRetry?.();
              } catch (err) {
                setError(errorText(err, 'The payment could not be started again.'));
              } finally {
                setBusy(false);
              }
            }}
            style={{ padding: '8px 20px' }}
          >
            {busy ? 'Trying again…' : 'Try again'}
          </button>
          <span style={{ marginLeft: 8, fontSize: '0.9em' }}>Nothing was sent, so trying again is safe.</span>
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: '0.9em' }}>
          {unsure
            ? 'Do not pay this invoice again. Nothing is retried automatically.'
            : 'Nothing is retried automatically.'}
        </div>
      )}
      {error && <p style={{ color: 'var(--wl-c-error)', margin: '8px 0 0' }}>{error}</p>}
    </div>
  );
}

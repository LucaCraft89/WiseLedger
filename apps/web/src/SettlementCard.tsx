import { useCallback, useEffect } from 'react';
import type { ApiClient } from './api/client.js';
import { formatDate } from './lib/format.js';
import { explorerTxUrl, shortId } from './lib/payment.js';
import { type LadderStep, settlementView } from './lib/settlement.js';
import { EXPLORER_BASE } from './PaymentCards.js';
import { CopyButton, ErrorBox, Loading, useLoad } from './ui.js';

const STEP_BADGE: Record<LadderStep['state'], { icon: string; word: string; tone: string }> = {
  done: { icon: '✓', word: 'Done', tone: 'ok' },
  current: { icon: '…', word: 'Now', tone: 'review' },
  pending: { icon: '○', word: 'Next', tone: 'info' },
  failed: { icon: '✕', word: 'Failed', tone: 'block' },
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

/**
 * "How this was settled": what RGB did for this payment, in plain lines, technical terms folded away.
 * `refreshKey` changes (e.g. the transfer status) reload it.
 */
export function SettlementCard({
  api,
  transferId,
  refreshKey,
}: {
  api: ApiClient;
  transferId: string;
  refreshKey?: string;
}) {
  const load = useCallback(() => api.transfer(transferId), [api, transferId]);
  const { data, error, loading, reload } = useLoad(load);
  useEffect(() => {
    if (refreshKey) reload();
  }, [refreshKey, reload]);
  // Follow a payment still in progress until it settles or fails.
  const open = data && data.transfer.status !== 'Settled' && data.transfer.status !== 'Failed';
  useEffect(() => {
    if (!open) return;
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [open, reload]);

  if (!data)
    return loading ? <Loading text="Loading how this was settled…" /> : <ErrorBox error={error} retry={reload} />;
  const v = settlementView(data);
  return (
    <div className="wl-card" data-testid="settlement-card" style={{ marginTop: 12 }}>
      <p style={{ marginTop: 0 }}>
        <strong>{v.headline}</strong>
      </p>
      <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0' }} aria-label="Payment status">
        {v.ladder.map((s) => {
          const b = STEP_BADGE[s.state];
          return (
            <li
              key={s.status}
              data-state={s.state}
              style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}
            >
              <span className="wl-badge" data-tone={b.tone}>
                <span aria-hidden="true">{b.icon}</span> {b.word}
              </span>
              <span style={{ color: s.state === 'pending' ? 'var(--wl-c-muted)' : undefined }}>
                {s.label}
                {s.at && <small style={{ color: 'var(--wl-c-muted)' }}> · {formatDate(s.at)}</small>}
              </span>
            </li>
          );
        })}
      </ol>
      {v.failedNext && <p role="alert">{v.failedNext}</p>}
      {v.validated && <p data-testid="validated">✓ {v.validated}</p>}
      {v.privacy && v.txid && (
        <p>
          {v.privacy}{' '}
          <a href={explorerTxUrl(v.txid, EXPLORER_BASE)} target="_blank" rel="noopener noreferrer">
            See it on the block explorer
          </a>
        </p>
      )}
      <details>
        <summary>Technical details</summary>
        <dl style={{ margin: '8px 0 0' }}>
          {v.tech.map((l) => (
            <div key={`${l.label}-${l.value}`} style={{ marginBottom: 8 }}>
              <dt style={{ fontWeight: 600 }}>{l.label}</dt>
              <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>
                {l.id ? (
                  <>
                    <code title={l.value}>{shortId(l.value)}</code> <CopyButton value={l.value} what={l.label} />
                  </>
                ) : (
                  <code title={l.value}>{ISO_RE.test(l.value) ? formatDate(l.value) : l.value}</code>
                )}
                <div style={{ fontSize: '0.9em', color: 'var(--wl-c-muted)' }}>{l.explain}</div>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

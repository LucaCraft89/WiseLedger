import { useReducer, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { formatAssetAmount, type TransferDto, type WalletResponse } from './api/contracts.js';
import { formatDate } from './lib/format.js';
import {
  addLabel,
  DIRECTION_WORDS,
  LABEL_MAX_LEN,
  labelEditReducer,
  removeLabel,
  TRANSFER_STATUS_WORDS,
} from './lib/ledger.js';
import { explorerTxUrl, shortId } from './lib/payment.js';
import { errorText, useToast } from './ui.js';

type Assets = WalletResponse['assets'];

const cell = { padding: '6px 8px', borderBottom: '1px solid var(--wl-c-line-soft)', verticalAlign: 'top' } as const;
const chip = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--wl-c-bubble-user)',
  borderRadius: 12,
  padding: '0 8px',
  margin: '0 4px 4px 0',
  fontSize: '0.85em',
} as const;

function amountText(t: TransferDto, assets: Assets): string {
  const a = assets.find((x) => x.assetId === t.assetId);
  return a ? `${formatAssetAmount(t.amount, a.precision)} ${a.ticker}` : `${t.amount} smallest units (token not known)`;
}

/** Transfers table: date, Sent/Received, amount, status, labels (editable inline), transaction link. */
export function TransfersTable({
  api,
  transfers,
  assets,
}: {
  api: ApiClient;
  transfers: readonly TransferDto[];
  assets: Assets;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.95em' }} data-testid="transfers-table">
        <thead>
          <tr style={{ textAlign: 'left' }}>
            <th style={cell}>Date</th>
            <th style={cell}>Type</th>
            <th style={cell}>Amount</th>
            <th style={cell}>Status</th>
            <th style={cell}>Labels</th>
            <th style={cell}>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((t) => (
            <tr key={t.transferId}>
              <td style={cell}>{formatDate(t.createdAt)}</td>
              <td style={cell}>{DIRECTION_WORDS[t.direction]}</td>
              <td style={{ ...cell, whiteSpace: 'nowrap' }}>{amountText(t, assets)}</td>
              <td style={cell}>{TRANSFER_STATUS_WORDS[t.status]}</td>
              <td style={cell}>
                <LabelCell api={api} transferId={t.transferId} initial={t.labels} />
              </td>
              <td style={cell}>
                {t.txid ? (
                  <a href={t.explorerUrl ?? explorerTxUrl(t.txid)} target="_blank" rel="noreferrer" title={t.txid}>
                    {shortId(t.txid, 6)}
                  </a>
                ) : t.paymentHash ? (
                  <span title={`Lightning payment hash ${t.paymentHash}`}>Lightning · {shortId(t.paymentHash, 6)}</span>
                ) : (
                  '—'
                )}
                {t.invoiceId && (
                  <div>
                    <a href={`#/invoice/${encodeURIComponent(t.invoiceId)}`}>Invoice</a>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Label chips; click "+ Add label" → type → Enter saves, Esc cancels. × removes a label. */
function LabelCell({ api, transferId, initial }: { api: ApiClient; transferId: string; initial: string[] }) {
  const toast = useToast();
  const [labels, setLabels] = useState(initial);
  const [s, dispatch] = useReducer(labelEditReducer, { mode: 'idle' });

  async function save(next: string[]) {
    try {
      const res = await api.setLabels(transferId, { labels: next });
      setLabels(res.labels);
      dispatch({ type: 'saved' });
    } catch (err) {
      const msg = errorText(err, 'Could not save the label.');
      dispatch({ type: 'failed', error: msg });
      toast(msg, 'error');
    }
  }

  function submit() {
    if (s.mode !== 'editing') return;
    const r = addLabel(labels, s.draft);
    if (!r.ok) return dispatch({ type: 'failed', error: r.error });
    dispatch({ type: 'save' });
    void save(r.labels);
  }

  return (
    <div>
      {labels.map((l) => (
        <span key={l} style={chip}>
          {l}
          <button
            type="button"
            aria-label={`Remove label ${l}`}
            disabled={s.mode === 'saving'}
            onClick={() => void save(removeLabel(labels, l))}
            style={{ border: 0, background: 'none', cursor: 'pointer', padding: 0 }}
          >
            ×
          </button>
        </span>
      ))}
      {s.mode === 'idle' ? (
        <button
          type="button"
          className="wl-secondary"
          aria-label="Add a label to this transfer"
          onClick={() => dispatch({ type: 'start' })}
          style={{ fontSize: '0.85em' }}
        >
          + Add label
        </button>
      ) : (
        <span>
          <input
            // biome-ignore lint/a11y/noAutofocus: the user just clicked "+ Add label"
            autoFocus
            aria-label="New label"
            value={s.draft}
            maxLength={LABEL_MAX_LEN}
            disabled={s.mode === 'saving'}
            placeholder="e.g. hosting"
            onChange={(e) => dispatch({ type: 'type', draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') dispatch({ type: 'cancel' });
            }}
            onBlur={() => s.mode === 'editing' && !s.draft.trim() && dispatch({ type: 'cancel' })}
            style={{ width: 110 }}
          />
          <small style={{ color: 'var(--wl-c-muted)' }}> Enter to save, Esc to cancel</small>
          {s.mode === 'editing' && s.error && (
            <div style={{ color: 'var(--wl-c-error)', fontSize: '0.85em' }}>{s.error}</div>
          )}
        </span>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { formatAssetAmount, type ReceiveRequestDto, type WalletResponse } from './api/contracts.js';
import { explorerTxUrl, shortId } from './lib/payment.js';
import {
  canUse,
  isOpen,
  likeHref,
  localTimeWithZone,
  RECEIVE_STATUS,
  receiveHref,
  whyNotUsable,
} from './lib/receive.js';
import { namesOf } from './lib/request-form.js';
import { EXPLORER_BASE } from './PaymentCards.js';
import { ReceiptCard } from './ReceiptCard.js';
import { CopyButton, ErrorBox, errorText, Loading, Qr, useLoad, useToast } from './ui.js';

type Assets = WalletResponse['assets'];

/** "10.00 TUSDT", "any amount of TUSDT" or "any amount". */
export function requestAmount(r: Pick<ReceiveRequestDto, 'amount' | 'receivedAmount' | 'assetId'>, assets: Assets) {
  const a = assets.find((x) => x.assetId === r.assetId);
  const amount = r.receivedAmount ?? r.amount;
  if (amount) return a ? `${formatAssetAmount(amount, a.precision)} ${a.ticker}` : `${amount} smallest units`;
  return a ? `any amount of ${a.ticker}` : 'any amount';
}

export function StatusBadge({ status }: { status: ReceiveRequestDto['status'] }) {
  const s = RECEIVE_STATUS[status];
  return (
    <span className="wl-badge" data-tone={s.tone}>
      <span aria-hidden="true">{s.icon}</span> {s.word}
    </span>
  );
}

/**
 * One payment request, read from the server by its ID (live status, survives reloads). `chat` = the card under a
 * Treasurer reply; `detail` = Wallet › Get paid › one request, with cancel and archive.
 */
export function ReceiveCard({
  api,
  receiveId,
  variant,
  onChanged,
}: {
  api: ApiClient;
  receiveId: string;
  variant: 'chat' | 'detail';
  onChanged?: () => void;
}) {
  const load = useCallback(() => api.receiveGet(receiveId), [api, receiveId]);
  const { data: r, error, reload } = useLoad(load);
  const loadWallet = useCallback(() => api.wallet(), [api]);
  const wallet = useLoad(loadWallet);
  const assets = wallet.data?.assets ?? [];
  const [qr, setQr] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // Follow it while someone may pay it.
  const open = !!r && (isOpen(r) || r.status === 'cancelled');
  useEffect(() => {
    if (!open) return;
    const id = setInterval(reload, 10_000);
    return () => clearInterval(id);
  }, [open, reload]);

  if (!r) {
    return error ? <ErrorBox error={error} retry={reload} /> : <Loading text="Loading the payment request…" />;
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast(done, 'success');
      setConfirming(false);
      reload();
      onChanged?.();
    } catch (err) {
      toast(errorText(err), 'error');
      reload();
    } finally {
      setBusy(false);
    }
  }

  const why = whyNotUsable(r);
  return (
    <section className="wl-card" data-testid="receive-card" data-status={r.status} aria-label="Payment request">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
        <strong style={{ fontSize: '1.1em' }}>Payment request · {requestAmount(r, assets)}</strong>
        <StatusBadge status={r.status} />
      </div>
      <p style={{ margin: '6px 0' }}>
        Valid until {localTimeWithZone(r.expiresAt)}
        {r.note && variant === 'detail' ? ` · ${r.note}` : ''}
      </p>

      {canUse(r) ? (
        <>
          <code
            title={r.rgbInvoice}
            data-testid="receive-request"
            style={{
              display: 'block',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              margin: '8px 0',
            }}
          >
            {shortId(r.rgbInvoice, 28)}
          </code>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <CopyButton value={r.rgbInvoice} what="Payment request" label="Copy payment request" large />
            <button
              type="button"
              className="wl-secondary"
              style={{ minHeight: 44 }}
              aria-expanded={qr}
              onClick={() => setQr((v) => !v)}
            >
              {qr ? 'Hide QR code' : 'Show QR code'}
            </button>
          </div>
          {qr && (
            <div style={{ marginTop: 12 }}>
              <Qr value={r.rgbInvoice} size={220} alt="QR code of the payment request" />
            </div>
          )}
          <p style={{ fontSize: '0.9em', color: 'var(--wl-c-muted)', marginBottom: 0 }}>
            Send it to whoever pays you; they paste it into their RGB wallet.
          </p>
        </>
      ) : (
        <p data-testid="receive-why">{why}</p>
      )}

      {r.status === 'received' && (
        <p style={{ margin: '6px 0' }}>
          {r.transferId && (
            <>
              Transfer ID: <code title={r.transferId}>{shortId(r.transferId)}</code>{' '}
              <CopyButton value={r.transferId} what="Transfer ID" />{' '}
            </>
          )}
          {r.txid && (
            <a href={explorerTxUrl(r.txid, EXPLORER_BASE)} target="_blank" rel="noopener noreferrer">
              View on the block explorer
            </a>
          )}
        </p>
      )}

      {variant === 'detail' && r.status === 'received' && r.transferId && (
        <ReceiptCard api={api} transferId={r.transferId} />
      )}

      {(r.status === 'expired' || r.status === 'cancelled' || r.status === 'failed') && (
        <button
          type="button"
          data-testid="receive-like"
          style={{ margin: '4px 0' }}
          onClick={() => {
            window.location.hash = likeHref(r.receiveId);
          }}
        >
          Make a new request like this
        </button>
      )}

      {variant === 'chat' ? (
        <p style={{ marginBottom: 0 }}>
          <a href={receiveHref(r.receiveId)}>Open under Wallet › Get paid</a>
        </p>
      ) : (
        <>
          <p style={{ fontSize: '0.9em', color: 'var(--wl-c-muted)' }}>
            Created {localTimeWithZone(r.createdAt)} · expires {localTimeWithZone(r.expiresAt)}
          </p>
          {r.status === 'waiting' &&
            (confirming ? (
              <div role="dialog" aria-labelledby="cancel-title" className="wl-card" style={{ marginTop: 8 }}>
                <strong id="cancel-title">Cancel this payment request?</strong>
                <p>
                  I will stop showing this request as open. If the payer already has it, they could still pay it until{' '}
                  {localTimeWithZone(r.expiresAt)}; you would still receive the money.
                </p>
                <button
                  type="button"
                  className="wl-accent"
                  disabled={busy}
                  style={{ minHeight: 44, marginRight: 8 }}
                  onClick={() => void act(() => api.receiveCancel(r.receiveId), 'Payment request cancelled')}
                >
                  Cancel request
                </button>
                <button
                  type="button"
                  className="wl-secondary"
                  style={{ minHeight: 44 }}
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="wl-secondary"
                style={{ minHeight: 44 }}
                onClick={() => setConfirming(true)}
              >
                Cancel this request
              </button>
            ))}
          {!isOpen(r) && !r.archivedAt && (
            <button
              type="button"
              className="wl-secondary"
              style={{ minHeight: 44, marginLeft: 8 }}
              disabled={busy}
              onClick={() => void act(() => api.receiveArchive(r.receiveId), 'Moved to older requests')}
            >
              Archive
            </button>
          )}
        </>
      )}
    </section>
  );
}

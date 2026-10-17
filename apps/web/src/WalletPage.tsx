import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { formatAssetAmount, type WalletReceiveResponse, type WalletResponse } from './api/contracts.js';
import { formatDate } from './lib/format.js';
import { recentTransfers } from './lib/ledger.js';
import { BACKEND_WORDS, NETWORK_WORDS, shortId, toBaseUnits } from './lib/live.js';
import { TransfersTable } from './TransfersTable.js';
import { CopyButton, Empty, ErrorBox, errorText, Loading, Qr, useLoad, useToast } from './ui.js';

const box = { border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 16 } as const;

export function WalletPage({ api }: { api: ApiClient }) {
  const toast = useToast();
  const [w, setW] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setW(await api.wallet());
    } catch (err) {
      const msg = errorText(err, 'Could not open the wallet.');
      setError(msg);
      toast(msg, 'error');
    }
  }, [api, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !w) {
    return (
      <section>
        <h2>Wallet</h2>
        <ErrorBox error={error} retry={() => void load()} />
      </section>
    );
  }
  if (!w) return <Loading text="Opening the wallet…" />;

  return (
    <section>
      <h2>Wallet</h2>
      <p>
        Wallet: {BACKEND_WORDS[w.backend]} · Network: {NETWORK_WORDS[w.network]} ·{' '}
        {w.ready ? 'Ready to use' : 'Not ready yet: press Refresh in a minute'}{' '}
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </p>

      <h3>Balances</h3>
      {w.assets.length === 0 && (
        <Empty text="This wallet holds no tokens yet. The “Getting started” tips above say how to get test tokens." />
      )}
      {w.assets.map((a) => (
        <div key={a.assetId} style={box} data-testid="asset-balance">
          <div style={{ fontSize: '1.3em' }}>
            <strong>{formatAssetAmount(a.balance.spendable, a.precision)}</strong> {a.ticker}{' '}
            <small style={{ color: '#555' }}>{a.name}</small>
          </div>
          <div>
            Available to spend: {formatAssetAmount(a.balance.spendable, a.precision)} · Confirmed:{' '}
            {formatAssetAmount(a.balance.settled, a.precision)}
            {a.balance.future !== a.balance.settled && (
              <> · Incoming included: {formatAssetAmount(a.balance.future, a.precision)}</>
            )}
          </div>
          <div style={{ fontSize: '0.9em', color: '#555' }}>
            Token ID (the unique code of this token, used in every payment):{' '}
            <code title={a.assetId}>{shortId(a.assetId)}</code> <CopyButton value={a.assetId} what="Token ID" />
          </div>
        </div>
      ))}
      {w.btcBalanceSats !== undefined && (
        <p>
          Bitcoin for network fees: <strong>{formatAssetAmount(w.btcBalanceSats, 8)} BTC</strong> (
          {Number(w.btcBalanceSats).toLocaleString()} sats)
        </p>
      )}

      <RecentTransfers api={api} assets={w.assets} />

      {w.address && (
        <>
          <h3>Bitcoin address</h3>
          <div style={{ ...box, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <Qr value={w.address} size={160} alt="QR code of the Bitcoin address" />
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0 }}>Send test bitcoin here to pay network fees.</p>
              <code style={{ wordBreak: 'break-all' }}>{w.address}</code>{' '}
              <CopyButton value={w.address} what="Address" />
            </div>
          </div>
        </>
      )}

      <ReceiveForm api={api} wallet={w} />
    </section>
  );
}

function RecentTransfers({ api, assets }: { api: ApiClient; assets: WalletResponse['assets'] }) {
  const load = useCallback(async () => recentTransfers((await api.transfers()).transfers, 10), [api]);
  const { data, error, loading, reload } = useLoad(load);
  return (
    <>
      <h3>Recent transfers</h3>
      <p style={{ marginTop: 0 }}>
        <a href="#/transfers">All transfers and fiscal report</a> · <a href="#/schedule">Scheduled payments</a>
      </p>
      {error ? <ErrorBox error={error} retry={reload} /> : null}
      {loading && !data ? <Loading text="Loading transfers…" /> : null}
      {data && data.length === 0 && <Empty text="No transfers yet." />}
      {data && data.length > 0 && <TransfersTable api={api} transfers={data} assets={assets} />}
    </>
  );
}

function ReceiveForm({ api, wallet }: { api: ApiClient; wallet: WalletResponse }) {
  const toast = useToast();
  const [assetId, setAssetId] = useState(wallet.assets[0]?.assetId ?? '');
  const [amount, setAmount] = useState('');
  const [expiry, setExpiry] = useState('60');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<WalletReceiveResponse | null>(null);

  const asset = wallet.assets.find((a) => a.assetId === assetId);

  async function submit() {
    setFormError(null);
    const base = toBaseUnits(amount, asset?.precision ?? 0);
    if (!base.ok) return setFormError(base.error);
    if (base.value && !asset) return setFormError('Choose the asset first, then the amount.');
    const minutes = Number(expiry);
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 60 * 24 * 7) {
      return setFormError('The time limit must be a whole number of minutes, up to one week (10080).');
    }
    setBusy(true);
    try {
      const res = await api.receive({
        ...(assetId ? { assetId } : {}),
        ...(base.value ? { amount: base.value } : {}),
        expiryMinutes: minutes,
      });
      setCreated(res);
      toast('Payment request created', 'success');
    } catch (err) {
      const msg = errorText(err, 'Could not create the payment request.');
      setFormError(msg);
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Receive a payment</h3>
      <form
        style={box}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p style={{ marginTop: 0 }}>
          Create a payment request (an “RGB invoice”) and send it to the person who will pay you. They paste it into
          their wallet.
        </p>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Asset{' '}
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            {wallet.assets.map((a) => (
              <option key={a.assetId} value={a.assetId}>
                {a.ticker} ({a.name})
              </option>
            ))}
            <option value="">Any asset</option>
          </select>
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Amount {asset ? `in ${asset.ticker}` : ''} (optional){' '}
          <input
            inputMode="decimal"
            placeholder="leave empty for any amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={!asset}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Valid for{' '}
          <input inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} style={{ width: 80 }} />{' '}
          minutes
        </label>
        {formError && <p style={{ color: '#b00020' }}>{formError}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create payment request'}
        </button>
      </form>

      {created && (
        <div style={{ ...box, background: '#f8f9fa' }} data-testid="receive-invoice">
          <strong>Your payment request</strong>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
            <Qr value={created.rgbInvoice} size={200} alt="QR code of the payment request" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <code style={{ wordBreak: 'break-all', display: 'block' }}>{created.rgbInvoice}</code>
              <CopyButton value={created.rgbInvoice} what="Payment request" label="Copy payment request" />
              {created.amount && asset && (
                <p>
                  Amount: {formatAssetAmount(created.amount, asset.precision)} {asset.ticker}
                </p>
              )}
              <p>Valid until {formatDate(created.expiresAt)}. After that, create a new one.</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

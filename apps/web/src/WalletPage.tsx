import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import {
  type BtcTransactionDto,
  formatAssetAmount,
  type LightningStatusResponse,
  type ReceiveFilter,
  type ReceiveRequestDto,
  type WalletReceiveResponse,
  type WalletResponse,
} from './api/contracts.js';
import { formatDate } from './lib/format.js';
import { BACKEND_WORDS, NETWORK_WORDS, shortId, toBaseUnits } from './lib/live.js';
import { explorerTxUrl } from './lib/payment.js';
import { isOpen, mergePage, openFirst, parseGetPaid, RECEIVE_FILTERS, receiveHref } from './lib/receive.js';
import { EXPLORER_BASE } from './PaymentCards.js';
import { ReceiveCard, requestAmount, StatusBadge } from './ReceiveCard.js';
import { CopyButton, Empty, ErrorBox, errorText, Loading, Qr, useLoad, useToast } from './ui.js';

const box = { border: '1px solid var(--wl-c-line)', borderRadius: 6, padding: 12, marginBottom: 16 } as const;

/** Settings › Your money, technically: the words of the wallet (token ID, address, Lightning, limits), each explained. */
export function MoneyPage({ api }: { api: ApiClient }) {
  const toast = useToast();
  const [w, setW] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setW(await api.wallet());
    } catch (err) {
      const msg = errorText(err, 'I could not open the wallet. Check that the server is running, then try again.');
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
        <h2>Your money, technically</h2>
        <ErrorBox error={error} retry={() => void load()} />
      </section>
    );
  }
  if (!w) return <Loading text="Opening your wallet… (a few seconds)" />;

  return (
    <section>
      <h2>Your money, technically</h2>
      <p>
        <a href="#/settings">← Settings</a>
      </p>
      <p style={{ color: 'var(--wl-c-muted)' }}>
        {BACKEND_WORDS[w.backend]} · {NETWORK_WORDS[w.network]} ·{' '}
        {w.ready ? 'Ready to use' : 'Not ready yet: check again in a minute'}{' '}
        <button type="button" className="wl-quiet" onClick={() => void load()}>
          Refresh
        </button>
      </p>

      <h3>Tokens</h3>
      {w.assets.length === 0 && (
        <Empty text="This wallet holds no tokens yet. The “Getting started” tips on the Desk say how to get test tokens." />
      )}
      {w.assets.map((a) => (
        <div key={a.assetId} style={box} data-testid="asset-balance">
          <div style={{ fontSize: '1.6em' }}>
            <strong>{formatAssetAmount(a.balance.spendable, a.precision)}</strong> {a.ticker}{' '}
            <small style={{ color: 'var(--wl-c-muted)', fontSize: '0.55em' }}>{a.name}</small>
          </div>
          <div style={{ color: 'var(--wl-c-muted)' }}>
            Ready to spend · confirmed {formatAssetAmount(a.balance.settled, a.precision)}
            {a.balance.future !== a.balance.settled && (
              <> · incoming included {formatAssetAmount(a.balance.future, a.precision)}</>
            )}
          </div>
          <div style={{ fontSize: '0.9em', color: 'var(--wl-c-muted)' }}>
            Token ID (the unique code of this token, used in every payment):{' '}
            <code title={a.assetId}>{shortId(a.assetId)}</code> <CopyButton value={a.assetId} what="Token ID" />
          </div>
        </div>
      ))}

      {w.btcBalanceSats !== undefined && (
        <>
          <BitcoinBalance sats={w.btcBalanceSats} />
          <BtcTransactions api={api} />
        </>
      )}
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
      <LightningPanel api={api} assets={w.assets} />
      {w.spending && <SpendingRules spending={w.spending} assets={w.assets} />}
    </section>
  );
}

/** The limits every payment must pass, and who enforces them (the Tether WDK policy engine on the real wallet). */
export function SpendingRules({
  spending,
  assets,
}: {
  spending: NonNullable<WalletResponse['spending']>;
  assets: WalletResponse['assets'];
}) {
  const asset = (id?: string) => assets.find((a) => a.assetId === id) ?? assets[0];
  const fmt = (v: string, id?: string) => {
    const a = asset(id);
    return a ? `${formatAssetAmount(v, a.precision)} ${a.ticker}` : `${v} smallest units`;
  };
  const main = spending.assetAllowlist[0] ?? assets[0]?.assetId;
  const spent = spending.spentLast24h.find((s) => s.assetId === main)?.amount ?? '0';
  const share = spending.dailyCap ? Math.min(100, Number((BigInt(spent) * 100n) / BigInt(spending.dailyCap))) : 0;
  const approved = spending.assetAllowlist.length
    ? spending.assetAllowlist.map((id) => asset(id)?.ticker ?? shortId(id)).join(', ')
    : 'any token';
  const wdk = spending.enforcedBy === 'wdk-policy';
  return (
    <>
      <h3>Safety limits</h3>
      <div style={box} data-testid="spending-rules">
        <div>
          Up to <strong>{fmt(spending.paymentCap, main)}</strong> per payment
          {spending.dailyCap && (
            <>
              {' '}
              · up to <strong>{fmt(spending.dailyCap, main)}</strong> in any 24 hours
            </>
          )}{' '}
          · approved tokens: <strong>{approved}</strong>
        </div>
        {spending.dailyCap && (
          <div style={{ marginTop: 8 }}>
            <div
              aria-hidden="true"
              style={{ height: 8, borderRadius: 4, background: 'var(--wl-c-line)', overflow: 'hidden' }}
            >
              <div
                style={{
                  width: `${share}%`,
                  height: '100%',
                  background: share >= 90 ? 'var(--wl-block)' : 'var(--md-primary)',
                }}
              />
            </div>
            <small style={{ color: 'var(--wl-c-muted)' }}>
              Spent in the last 24 hours: {fmt(spent, main)} of {fmt(spending.dailyCap, main)}
            </small>
          </div>
        )}
        <p style={{ margin: '8px 0 0', fontSize: '0.9em', color: 'var(--wl-c-muted)' }}>
          {wdk
            ? 'Enforced twice: by WiseLedger before it asks the wallet, and by the Tether WDK policy engine inside the wallet itself. A payment over a limit is refused before anything is signed, whatever the AI says.'
            : 'Checked by WiseLedger before every payment, whatever the AI says. (On the real wallet the Tether WDK policy engine enforces them too.)'}
        </p>
      </div>
    </>
  );
}

/** Spendable and receivable over Lightning, per asset, summed over usable channels. */
export function lightningTotals(ln: LightningStatusResponse): { assetId?: string; send: bigint; receive: bigint }[] {
  const by = new Map<string, { assetId?: string; send: bigint; receive: bigint }>();
  for (const c of ln.channels) {
    if (!c.usable) continue;
    const key = c.assetId ?? '';
    const row = by.get(key) ?? { ...(c.assetId ? { assetId: c.assetId } : {}), send: 0n, receive: 0n };
    row.send += BigInt(c.localAsset);
    row.receive += BigInt(c.remoteAsset);
    by.set(key, row);
  }
  return [...by.values()];
}

/** Lightning panel from GET /api/wallet/lightning. Hidden while loading; "off" when the server has no Lightning. */
export function LightningPanel({ api, assets }: { api: ApiClient; assets: WalletResponse['assets'] }) {
  const [ln, setLn] = useState<LightningStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .lightning()
      .then((r) => live && setLn(r))
      .catch(
        (err: unknown) =>
          live && setError(errorText(err, 'I could not read the Lightning status. Try again in a minute.')),
      );
    return () => {
      live = false;
    };
  }, [api]);
  if (error) return <p style={{ color: 'var(--wl-c-muted)' }}>Lightning: {error}</p>;
  if (!ln) return null;
  if (!ln.enabled) {
    return (
      <p data-testid="lightning-off" style={{ color: 'var(--wl-c-muted)' }}>
        Lightning (instant payments) is off in this wallet. Invoices that ask for Lightning will be stopped.
      </p>
    );
  }
  const usable = ln.channels.filter((c) => c.usable).length;
  const fmt = (assetId: string | undefined, v: bigint) => {
    const a = assets.find((x) => x.assetId === assetId);
    return a ? `${formatAssetAmount(v.toString(), a.precision)} ${a.ticker}` : `${v.toString()} smallest units`;
  };
  return (
    <>
      <h3>Lightning (instant payments)</h3>
      <div style={box} data-testid="lightning-panel">
        <div>
          {usable === 0
            ? 'No Lightning channel is ready yet, so payments go on-chain. A channel opens on first start; check back in a few minutes.'
            : `${usable} channel${usable === 1 ? '' : 's'} ready.`}
        </div>
        {ln.problem && <div style={{ color: 'var(--wl-c-warn-text)' }}>{ln.problem}</div>}
        {lightningTotals(ln).map((t) => (
          <div key={t.assetId ?? 'unknown'}>
            Can send now: <strong>{fmt(t.assetId, t.send)}</strong> · Can receive: {fmt(t.assetId, t.receive)}
          </div>
        ))}
        {ln.nodePubkey && (
          <div style={{ fontSize: '0.9em', color: 'var(--wl-c-muted)' }}>
            Your Lightning node: <code title={ln.nodePubkey}>{shortId(ln.nodePubkey)}</code>{' '}
            <CopyButton value={ln.nodePubkey} what="Node ID" />
          </div>
        )}
      </div>
    </>
  );
}

/** Below this many sats a token payment may fail: the wallet cannot pay the network fee. */
export const LOW_SATS = 5_000;

const BTC_PURPOSE_WORDS: Record<BtcTransactionDto['purpose'], string> = {
  token_payment: 'Network fee for a token payment',
  utxo_setup: 'Preparing the wallet to hold tokens',
  drain: 'Wallet emptied to another address',
  bitcoin: 'Test bitcoin',
};

function BitcoinBalance({ sats }: { sats: string }) {
  const low = Number(sats) < LOW_SATS;
  return (
    <div style={box} data-testid="sats-balance">
      <div style={{ fontSize: '1.3em' }}>
        <strong>{Number(sats).toLocaleString()}</strong> sats{' '}
        <small style={{ color: 'var(--wl-c-muted)' }}>
          Bitcoin for network fees ({formatAssetAmount(sats, 8)} BTC)
        </small>
      </div>
      <div style={{ fontSize: '0.9em', color: 'var(--wl-c-muted)' }}>
        Sats are not your tokens. Every token payment needs a few sats to pay the network, so keep some in the wallet.
      </div>
      {low && (
        <p role="alert" style={{ color: 'var(--wl-c-danger, #b00020)', marginBottom: 0 }}>
          Low on sats: a token payment may fail. Send test bitcoin to the address below.
        </p>
      )}
    </div>
  );
}

function BtcTransactions({ api }: { api: ApiClient }) {
  const load = useCallback(async () => (await api.btcTransactions()).transactions.slice(0, 10), [api]);
  const { data, error, loading, reload } = useLoad(load);
  return (
    <>
      <h3>Bitcoin (sats) activity</h3>
      {error ? <ErrorBox error={error} retry={reload} /> : null}
      {loading && !data ? <Loading text="Loading Bitcoin activity…" /> : null}
      {data && data.length === 0 && <Empty text="No Bitcoin activity yet." />}
      {data?.map((t) => (
        <div key={t.txid} style={{ ...box, marginBottom: 8 }} data-testid="btc-row">
          <strong>
            {t.direction === 'received' ? '+' : t.direction === 'sent' ? '−' : ''}
            {Number(t.amountSats).toLocaleString()} sats
          </strong>
          {Number(t.feeSats) > 0 && <> · fee {Number(t.feeSats).toLocaleString()} sats</>}
          {' · '}
          {t.direction === 'received' ? 'Received' : BTC_PURPOSE_WORDS[t.purpose]}
          <div style={{ fontSize: '0.9em', marginTop: 4 }}>
            {t.confirmed && t.createdAt ? formatDate(t.createdAt) : 'Waiting for a block'}
            {' · '}
            <a href={explorerTxUrl(t.txid, EXPLORER_BASE)} target="_blank" rel="noopener noreferrer">
              View on the block explorer
            </a>
          </div>
        </div>
      ))}
    </>
  );
}

/** Get paid: one request (#/get-paid/<id>), or the form (pre-filled with ?like=<id>) and the list. */
export function GetPaid({ api, wallet, hash }: { api: ApiClient; wallet: WalletResponse; hash: string }) {
  const { receiveId, like } = parseGetPaid(hash);
  const [listTick, setListTick] = useState(0);
  if (receiveId) {
    return (
      <>
        <p>
          <a href="#/get-paid">← All payment requests</a>
        </p>
        <ReceiveCard api={api} receiveId={receiveId} variant="detail" />
      </>
    );
  }
  return (
    <>
      <ReceiveForm api={api} wallet={wallet} like={like} onCreated={() => setListTick((t) => t + 1)} />
      <PaymentRequests api={api} wallet={wallet} tick={listTick} />
    </>
  );
}

function ReceiveForm({
  api,
  wallet,
  like,
  onCreated,
}: {
  api: ApiClient;
  wallet: WalletResponse;
  /** receiveId of an old request to copy (amount, token, note). */
  like?: string | undefined;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [assetId, setAssetId] = useState(wallet.assets[0]?.assetId ?? '');
  const [amount, setAmount] = useState('');
  const [expiry, setExpiry] = useState('60');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<WalletReceiveResponse | null>(null);

  // "Make a new request like this": same token, amount and note as the old one.
  useEffect(() => {
    if (!like) return;
    let live = true;
    api.receiveGet(like).then(
      (r) => {
        if (!live) return;
        const a = wallet.assets.find((x) => x.assetId === r.assetId);
        setAssetId(r.assetId ?? '');
        setAmount(r.amount && a ? formatAssetAmount(r.amount, a.precision) : '');
        setNote(r.note ?? '');
        setCreated(null);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, like, wallet.assets]);

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
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setCreated(res);
      setNote('');
      onCreated();
      toast('Payment request created', 'success');
    } catch (err) {
      const msg = errorText(err, 'I could not create the payment request. Check the amount and try again.');
      setFormError(msg);
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Make a payment request</h3>
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
        {like && <p data-testid="receive-prefilled">Filled in like your earlier request: check it, then create it.</p>}
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
          Who pays, or what for (optional){' '}
          <input
            maxLength={120}
            placeholder="e.g. Acme, refund October"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Valid for{' '}
          <input inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} style={{ width: 80 }} />{' '}
          minutes
        </label>
        {formError && <p style={{ color: 'var(--wl-c-error)' }}>{formError}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create payment request'}
        </button>
      </form>

      {created?.receiveId ? (
        <div data-testid="receive-invoice">
          <ReceiveCard api={api} receiveId={created.receiveId} variant="detail" onChanged={onCreated} />
        </div>
      ) : (
        created && (
          <div style={{ ...box, background: 'var(--wl-c-subtle-bg)' }} data-testid="receive-invoice">
            <strong>Your payment request</strong>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
              <Qr value={created.rgbInvoice} size={200} alt="QR code of the payment request" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <code style={{ wordBreak: 'break-all', display: 'block' }}>{created.rgbInvoice}</code>
                <CopyButton value={created.rgbInvoice} what="Payment request" label="Copy payment request" />
                <p>Valid until {formatDate(created.expiresAt)}. After that, create a new one.</p>
              </div>
            </div>
          </div>
        )
      )}
    </>
  );
}

/** Payment requests handed out: open ones first, filter chips, 20 at a time, older ones folded away. */
export function PaymentRequests({ api, wallet, tick }: { api: ApiClient; wallet: WalletResponse; tick: number }) {
  const [filter, setFilter] = useState<ReceiveFilter>('all');
  const [olderOpen, setOlderOpen] = useState(false);
  return (
    <>
      <h3>Payment requests you sent</h3>
      <fieldset style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, border: 0, padding: 0 }}>
        <legend style={{ position: 'absolute', left: -9999 }}>Show</legend>
        {RECEIVE_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filter === f.id ? undefined : 'wl-secondary'}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      <RequestList api={api} wallet={wallet} tick={tick} filter={filter} older={false} />
      <details
        style={{ marginTop: 12 }}
        open={olderOpen}
        onToggle={(e) => setOlderOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>Older requests</summary>
        {olderOpen && <RequestList api={api} wallet={wallet} tick={tick} filter={filter} older />}
      </details>
    </>
  );
}

function RequestList({
  api,
  wallet,
  tick,
  filter,
  older,
}: {
  api: ApiClient;
  wallet: WalletResponse;
  tick: number;
  filter: ReceiveFilter;
  older: boolean;
}) {
  const [list, setList] = useState<ReceiveRequestDto[] | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const query = useCallback(
    (before?: string) => api.receives({ status: filter, archived: older ? '1' : '0', ...(before ? { before } : {}) }),
    [api, filter, older],
  );
  useEffect(() => {
    void tick;
    void refresh;
    let live = true;
    query().then(
      (r) => {
        if (!live) return;
        setList(r.receives);
        setNext(r.nextBefore);
        setError(null);
      },
      (e: unknown) => {
        if (live) setError(e);
      },
    );
    return () => {
      live = false;
    };
  }, [query, tick, refresh]);
  const open = list?.some((r) => isOpen(r));
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setRefresh((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, [open]);

  if (error) return <ErrorBox error={error} retry={() => setRefresh((n) => n + 1)} />;
  if (!list) return <Loading text="Loading your payment requests…" />;
  if (list.length === 0) {
    return (
      <Empty
        text={
          older
            ? 'No older requests.'
            : filter === 'all'
              ? 'No payment requests yet. Create one above to get paid.'
              : 'Nothing here. Try another filter, or look under “Older requests”.'
        }
      />
    );
  }
  return (
    <div aria-live="polite">
      {openFirst(list).map((r) => (
        <PaymentRequestRow key={r.receiveId} r={r} wallet={wallet} />
      ))}
      {next && (
        <button
          type="button"
          className="wl-secondary"
          disabled={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            try {
              const r = await query(next);
              setList((cur) => mergePage(cur ?? [], r.receives));
              setNext(r.nextBefore);
            } catch (e) {
              setError(e);
            } finally {
              setLoadingMore(false);
            }
          }}
        >
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export function PaymentRequestRow({ r, wallet }: { r: ReceiveRequestDto; wallet: WalletResponse }) {
  return (
    <a
      href={receiveHref(r.receiveId)}
      data-testid="receive-row"
      data-status={r.status}
      style={{ ...box, marginBottom: 8, display: 'block', color: 'inherit', textDecoration: 'none' }}
    >
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <StatusBadge status={r.status} />
        <strong>{requestAmount(r, wallet.assets)}</strong>
        {r.note ? <span>· {r.note}</span> : null}
      </span>
      <span style={{ display: 'block', fontSize: '0.9em', marginTop: 4, color: 'var(--wl-c-muted)' }}>
        Created {formatDate(r.createdAt)}
        {r.cancelledAt && r.status === 'received' ? ' · arrived after you cancelled it' : ''} ·{' '}
        <span style={{ color: 'var(--wl-c-link, inherit)', textDecoration: 'underline' }}>Open</span>
      </span>
    </a>
  );
}

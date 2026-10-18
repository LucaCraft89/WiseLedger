import { useCallback, useEffect, useMemo, useState } from 'react';
import { type ApiClient, LIGHTNING_OFF } from './api/client.js';
import {
  formatAssetAmount,
  OWL_NAME,
  type ReceiveRequestDto,
  type WalletReceiveResponse,
  type WalletResponse,
} from './api/contracts.js';
import { groupDigits } from './lib/desk.js';
import { shortDate } from './lib/format.js';
import { toBaseUnits } from './lib/live.js';
import { isOpen, likeHref, mergePage, parseGetPaid, receiveHref } from './lib/receive.js';
import {
  dateInputValue,
  expiryMinutes,
  LIGHTNING_OFF_LINE,
  namesOf,
  nextBusinessDay2359,
  requestButtonLabel,
  requestOwlLine,
  requestStamp,
  shortName,
  VALID_CHOICES,
  type ValidChoice,
  validUntil,
  validUntilWords,
} from './lib/request-form.js';
import { ReceiveCard } from './ReceiveCard.js';
import { Slip, Stamp, useChangedTo } from './Stamp.js';
import { CopyButton, ErrorBox, errorText, Loading, Qr, useLoad, useToast } from './ui.js';
import { lightningTotals } from './WalletPage.js';

type Assets = WalletResponse['assets'];

const money = (amount: string | undefined, assetId: string | undefined, assets: Assets): string => {
  const a = assets.find((x) => x.assetId === assetId);
  if (!amount) return 'Any amount';
  return a ? `${groupDigits(formatAssetAmount(amount, a.precision))} ${a.ticker}` : amount;
};

/** The owl's bubble beside a heading. */
function Say({ children, tone }: { children: string; tone?: 'block' }) {
  return (
    <div className="wl-talk" style={{ margin: 0 }}>
      <img src="/brand/owl-192.png" width={48} height={48} alt="" className="wl-owl-face" />
      <div className="wl-bubble" data-tone={tone} role="status">
        <p style={{ margin: 0 }}>{children}</p>
      </div>
    </div>
  );
}

/** The slip for a request that exists: its stamp follows the real status (OPEN → ARRIVING → PAID …). */
function CreatedSlip({
  api,
  created,
  assets,
  onAgain,
  onChanged,
}: {
  api: ApiClient;
  created: WalletReceiveResponse;
  assets: Assets;
  onAgain: () => void;
  onChanged: () => void;
}) {
  const id = created.receiveId ?? '';
  const [r, setR] = useState<ReceiveRequestDto | null>(null);
  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setR(await api.receiveGet(id));
    } catch {
      // keep the last known state; the list below shows the error if it persists
    }
  }, [api, id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const status = r?.status ?? 'waiting';
  const open = isOpen({ status });
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [open, refresh]);
  const paidNow = useChangedTo(status, 'received');
  useEffect(() => {
    if (!open) onChanged();
  }, [open, onChanged]);

  const { payer, purpose } = namesOf(r ?? {});
  const who = shortName(payer ?? '');
  const amountText = money(r?.receivedAmount ?? r?.amount ?? created.amount, r?.assetId ?? created.assetId, assets);
  const until = new Date(r?.expiresAt ?? created.expiresAt);
  const invoice = r?.rgbInvoice ?? created.rgbInvoice;
  const stamp = requestStamp(status);

  return (
    <div data-testid="receive-invoice">
      <Say tone={status === 'failed' ? 'block' : undefined}>
        {requestOwlLine(status, who, status === 'received' ? amountText : '')}
      </Say>
      <Slip
        title="PAYMENT REQUEST"
        stamp={<Stamp key={stamp} kind={stamp} grow={paidNow} />}
        rows={[
          { label: 'From', value: 'You' },
          { label: 'To', value: payer ?? '—' },
          ...(purpose ? [{ label: 'For', value: purpose }] : []),
          { label: 'Valid until', value: validUntilWords(until).replace('Valid until ', '') },
          { label: 'How', value: 'On-chain, about a minute' },
        ]}
        amount={amountText}
      >
        {open && (
          <>
            <Qr value={invoice} size={220} alt="QR code of the payment request" />
            <code className="wl-slip-code" title={invoice}>
              {invoice}
            </code>
            <div>
              <CopyButton value={invoice} what="Payment request" label="Copy payment request" large />
            </div>
          </>
        )}
      </Slip>
      {status === 'received' && id && (
        <p>
          <a href={receiveHref(id)}>Open the receipt</a>
        </p>
      )}
      <button type="button" className="wl-linkbutton" onClick={onAgain}>
        Ask for something else
      </button>
    </div>
  );
}

function RequestForm({
  api,
  assets,
  like,
  onCreated,
}: {
  api: ApiClient;
  assets: Assets;
  like?: string | undefined;
  onCreated: (r: WalletReceiveResponse) => void;
}) {
  const toast = useToast();
  const now = useMemo(() => new Date(), []);
  const [assetId, setAssetId] = useState(assets[0]?.assetId ?? '');
  const [amount, setAmount] = useState('');
  const [anyAmount, setAnyAmount] = useState(false);
  const [lightning, setLightning] = useState(false);
  const [payer, setPayer] = useState('');
  const [purpose, setPurpose] = useState('');
  const [choice, setChoice] = useState<ValidChoice>('1d');
  const [dateStr, setDateStr] = useState(() => dateInputValue(nextBusinessDay2359(now)));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const lnLoad = useCallback(() => api.lightning().catch(() => LIGHTNING_OFF), [api]);
  const { data: ln } = useLoad(lnLoad);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.payees(payer.trim()).then(
        (r) => live && setSuggestions(r.names),
        () => undefined,
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [api, payer]);

  useEffect(() => {
    if (!like) return;
    let live = true;
    api.receiveGet(like).then(
      (r) => {
        if (!live) return;
        const a = assets.find((x) => x.assetId === r.assetId);
        const { payer: p, purpose: q } = namesOf(r);
        setAssetId(r.assetId ?? assets[0]?.assetId ?? '');
        setAmount(r.amount && a ? formatAssetAmount(r.amount, a.precision) : '');
        setAnyAmount(!r.amount);
        setPayer(p ?? '');
        setPurpose(q ?? '');
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, like, assets]);

  const asset = assets.find((a) => a.assetId === assetId);
  const until = validUntil(choice, now, dateStr);
  const parsed = anyAmount ? undefined : toBaseUnits(amount, asset?.precision ?? 0);
  const amountText =
    parsed?.ok && parsed.value ? groupDigits(formatAssetAmount(parsed.value, asset?.precision ?? 0)) : '';
  const lnRoom = ln ? lightningTotals(ln).find((t) => !t.assetId || t.assetId === assetId) : undefined;
  const lnReason =
    ln?.enabled && lnRoom && asset && lnRoom.receive > 0n
      ? `Lightning can receive up to ${groupDigits(formatAssetAmount(lnRoom.receive.toString(), asset.precision))} ${asset.ticker} right now`
      : ln?.enabled
        ? 'Lightning has no room to receive yet'
        : 'Lightning is not set up on this computer';
  // Lightning needs a fixed amount within the channel's room; otherwise the request goes on-chain.
  const lnReady = !!(ln?.enabled && lnRoom && lnRoom.receive > 0n);
  const lnFits =
    lnReady && !anyAmount && !!parsed?.ok && !!parsed.value && BigInt(parsed.value) <= (lnRoom?.receive ?? 0n);
  const useLightning = lightning && lnFits;

  async function submit() {
    setFormError(null);
    const base: ReturnType<typeof toBaseUnits> = anyAmount ? { ok: true } : toBaseUnits(amount, asset?.precision ?? 0);
    if (!base.ok) return setFormError(base.error);
    if (!anyAmount && !base.value) return setFormError('Type how much, or tick “Let them choose the amount”.');
    const mins = expiryMinutes(until, new Date());
    if (!mins.ok) return setFormError(mins.error);
    setBusy(true);
    try {
      const res = await api.receive({
        ...(assetId ? { assetId } : {}),
        ...(base.value ? { amount: base.value } : {}),
        // Presets are exact durations; a picked day is an exact moment.
        ...(choice === 'date' ? { validUntil: until.toISOString() } : { expirySec: mins.minutes * 60 }),
        ...(payer.trim() ? { payer: payer.trim() } : {}),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        madeIn: 'form',
        ...(useLightning ? { rail: 'lightning' as const } : {}),
      });
      onCreated(res);
    } catch (err) {
      const msg = errorText(err, 'I could not create the payment request. Check the amount and try again.');
      setFormError(msg);
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wl-gp">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {like && <p data-testid="receive-prefilled">Filled in like your earlier request: check it, then create it.</p>}
        <div className="wl-field">
          <label className="wl-label" htmlFor="gp-amount">
            How much?
          </label>
          <div className="wl-amount">
            <input
              id="gp-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={anyAmount ? '' : amount}
              disabled={anyAmount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span>{asset?.ticker ?? ''}</span>
          </div>
          <label className="wl-check">
            <input type="checkbox" checked={anyAmount} onChange={(e) => setAnyAmount(e.target.checked)} />
            Let them choose the amount
          </label>
        </div>

        {assets.length > 1 && (
          <fieldset className="wl-field">
            <legend>Which token?</legend>
            <div className="wl-choices">
              {assets.map((a) => (
                <button
                  key={a.assetId}
                  type="button"
                  aria-pressed={a.assetId === assetId}
                  className={a.assetId === assetId ? undefined : 'wl-secondary'}
                  onClick={() => setAssetId(a.assetId)}
                >
                  {a.ticker}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <div className="wl-field">
          <label className="wl-label" htmlFor="gp-payer">
            Who pays you?
          </label>
          <input
            id="gp-payer"
            list="gp-payers"
            maxLength={60}
            autoComplete="off"
            placeholder="e.g. Acme Srl"
            value={payer}
            onChange={(e) => setPayer(e.target.value)}
          />
          <datalist id="gp-payers">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>

        <div className="wl-field">
          <label className="wl-label" htmlFor="gp-purpose">
            What for?
          </label>
          <input
            id="gp-purpose"
            maxLength={50}
            autoComplete="off"
            placeholder="e.g. October hosting"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>

        <fieldset className="wl-field">
          <legend>Valid for</legend>
          <div className="wl-choices">
            {VALID_CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={choice === c.id}
                className={choice === c.id ? undefined : 'wl-secondary'}
                onClick={() => setChoice(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          {choice === 'date' && (
            <input
              type="date"
              aria-label="Valid until this day"
              style={{ marginTop: 8 }}
              value={dateStr}
              min={dateInputValue(now)}
              max={dateInputValue(new Date(now.getTime() + 7 * 86_400_000))}
              onChange={(e) => setDateStr(e.target.value)}
            />
          )}
          <p className="wl-hint">{validUntilWords(until)}</p>
        </fieldset>

        <fieldset className="wl-field">
          <legend>How should they pay?</legend>
          <div className="wl-choices">
            <button
              type="button"
              className={useLightning ? 'wl-secondary' : undefined}
              aria-pressed={!useLightning}
              onClick={() => setLightning(false)}
            >
              On-chain (about a minute)
            </button>
            <button
              type="button"
              className={useLightning ? undefined : 'wl-secondary'}
              aria-disabled={!lnReady}
              aria-pressed={useLightning}
              onClick={() => lnReady && setLightning(true)}
            >
              Lightning (instant)
            </button>
          </div>
          <p className="wl-hint">
            {!lnReady
              ? `${lnReason}. ${LIGHTNING_OFF_LINE}`
              : lightning && !lnFits
                ? `${lnReason}: type a fixed amount within that, or this one goes on-chain.`
                : useLightning
                  ? `${lnReason}. They pay from an RGB Lightning wallet and it arrives in seconds.`
                  : `${lnReason}.`}
          </p>
        </fieldset>

        {formError && (
          <p role="alert" style={{ color: 'var(--wl-c-error)' }}>
            {formError}
          </p>
        )}
        <button type="submit" disabled={busy} style={{ minHeight: 48 }}>
          {busy
            ? 'Creating…'
            : requestButtonLabel({
                payer,
                anyAmount,
                amountText,
                ticker: asset?.ticker ?? '',
              })}
        </button>
      </form>

      <aside aria-label="Preview of the payment request">
        <Slip
          title="PAYMENT REQUEST"
          stamp={<Stamp kind="OPEN" />}
          rows={[
            { label: 'From', value: 'You' },
            { label: 'To', value: payer.trim() || '—' },
            { label: 'For', value: purpose.trim() || '—' },
            { label: 'Valid until', value: validUntilWords(until).replace('Valid until ', '') },
            { label: 'How', value: 'On-chain, about a minute' },
          ]}
          amount={anyAmount ? 'Any amount' : `${amountText || '0.00'} ${asset?.ticker ?? ''}`.trim()}
        />
      </aside>
    </div>
  );
}

type Segment = 'open' | 'paid' | 'older';
const SEGMENTS: readonly { id: Segment; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'paid', label: 'Paid' },
  { id: 'older', label: 'Older' },
];

/** "Who owes you": ledger lines, one action each. Cancel and archive live in the row's ⋯ menu. */
function WhoOwesYou({ api, assets, tick }: { api: ApiClient; assets: Assets; tick: number }) {
  const toast = useToast();
  const [segment, setSegment] = useState<Segment>('open');
  const [rows, setRows] = useState<ReceiveRequestDto[] | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);

  const query = useCallback(
    async (before?: string) => {
      const b = before ? { before } : {};
      if (segment === 'older') {
        const [closed, archived] = await Promise.all([
          api.receives({ status: 'closed', archived: '0', ...b }),
          api.receives({ status: 'all', archived: '1', ...b }),
        ]);
        const seen = new Set<string>();
        const merged = [...closed.receives, ...archived.receives]
          .filter((r) => !seen.has(r.receiveId) && seen.add(r.receiveId))
          .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
        return { receives: merged, nextBefore: closed.nextBefore ?? archived.nextBefore };
      }
      return api.receives({ status: segment, archived: '0', ...b });
    },
    [api, segment],
  );
  useEffect(() => {
    void tick;
    void refresh;
    let live = true;
    query().then(
      (r) => {
        if (!live) return;
        setRows(r.receives);
        setNext(r.nextBefore);
        setError(null);
      },
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [query, tick, refresh]);
  const anyOpen = rows?.some((r) => isOpen(r));
  useEffect(() => {
    if (!anyOpen) return;
    const t = setInterval(() => setRefresh((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, [anyOpen]);

  async function act(what: 'cancel' | 'archive', id: string) {
    try {
      await (what === 'cancel' ? api.receiveCancel(id) : api.receiveArchive(id));
      setRefresh((n) => n + 1);
    } catch (err) {
      toast(errorText(err, 'I could not do that. Try again in a moment.'), 'error');
    }
  }

  return (
    <>
      <h3>Who owes you</h3>
      <fieldset className="wl-segmented">
        <legend className="wl-visually-hidden">Show</legend>
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={segment === s.id}
            onClick={() => {
              setRows(null);
              setSegment(s.id);
            }}
          >
            {s.label}
          </button>
        ))}
      </fieldset>
      {error ? <ErrorBox error={error} retry={() => setRefresh((n) => n + 1)} /> : null}
      {!rows && !error ? <Loading text="Loading…" /> : null}
      {rows && rows.length === 0 && (
        <p style={{ color: 'var(--wl-c-muted)', fontStyle: 'italic' }}>
          {segment === 'open'
            ? 'Nobody owes you anything right now. Ask for money above.'
            : segment === 'paid'
              ? 'Nothing paid yet.'
              : 'Nothing older.'}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="wl-ledger-list" aria-label="Who owes you" aria-live="polite">
          {rows.map((r) => (
            <OweRow key={r.receiveId} r={r} assets={assets} onAct={act} />
          ))}
        </ul>
      )}
      {next && (
        <button
          type="button"
          className="wl-secondary"
          onClick={async () => {
            try {
              const r = await query(next);
              setRows((cur) => mergePage(cur ?? [], r.receives));
              setNext(r.nextBefore);
            } catch (e) {
              setError(e);
            }
          }}
        >
          Show more
        </button>
      )}
    </>
  );
}

function OweRow({
  r,
  assets,
  onAct,
}: {
  r: ReceiveRequestDto;
  assets: Assets;
  onAct: (what: 'cancel' | 'archive', id: string) => void;
}) {
  const { payer, purpose } = namesOf(r);
  const kind = requestStamp(r.status);
  const when =
    r.status === 'received'
      ? `paid ${shortDate(r.updatedAt)}`
      : r.status === 'waiting' || r.status === 'incoming'
        ? `valid until ${shortDate(r.expiresAt)}`
        : `${r.status === 'cancelled' ? 'cancelled' : 'ended'} ${shortDate(r.updatedAt)}`;
  const reopen = r.status === 'expired' || r.status === 'cancelled' || r.status === 'failed';
  return (
    <li data-testid="receive-row" data-status={r.status}>
      <Stamp kind={kind} />
      <a href={receiveHref(r.receiveId)} className="what" style={{ color: 'inherit', textDecoration: 'none' }}>
        <strong>{payer ?? purpose ?? 'Payment request'}</strong>
        {payer && purpose ? ` · ${purpose}` : ''}
        {r.madeIn === 'chat' && <span className="wl-tag">made with {OWL_NAME}</span>}
        <small>{when}</small>
      </a>
      <span className="num wl-in">{money(r.receivedAmount ?? r.amount, r.assetId, assets)}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {r.status === 'waiting' ? (
          <CopyButton value={r.rgbInvoice} what="Payment request" label="Copy" />
        ) : reopen ? (
          <a className="wl-secondary wl-button" href={likeHref(r.receiveId)}>
            Ask again
          </a>
        ) : null}
        {(r.status === 'waiting' || (!isOpen(r) && !r.archivedAt)) && (
          <details className="wl-menu">
            <summary aria-label="More actions">⋯</summary>
            <div>
              {r.status === 'waiting' && (
                <button type="button" className="wl-quiet" onClick={() => onAct('cancel', r.receiveId)}>
                  Cancel this request
                </button>
              )}
              {!isOpen(r) && !r.archivedAt && (
                <button type="button" className="wl-quiet" onClick={() => onAct('archive', r.receiveId)}>
                  Move to Older
                </button>
              )}
            </div>
          </details>
        )}
      </span>
    </li>
  );
}

/** `#/get-paid`: ask for money. One request (#/get-paid/<id>) opens its detail; `?like=<id>` prefills the form. */
export function GetPaidPage({ api, hash }: { api: ApiClient; hash: string }) {
  const { receiveId, like } = parseGetPaid(hash);
  const load = useCallback(() => api.wallet(), [api]);
  const { data, error, reload } = useLoad(load);
  const [created, setCreated] = useState<WalletReceiveResponse | null>(null);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  return (
    <section>
      <div className="wl-gp-head">
        <h2>Get paid</h2>
        {!created && <Say>Who owes you, and how much?</Say>}
      </div>
      {error ? (
        <ErrorBox error={errorText(error, 'I could not open your money. Try again in a moment.')} retry={reload} />
      ) : null}
      {!data && !error ? <Loading text="Opening… (a few seconds)" /> : null}
      {data && receiveId ? (
        <>
          <p>
            <a href="#/get-paid">← Back to Get paid</a>
          </p>
          <ReceiveCard api={api} receiveId={receiveId} variant="detail" />
        </>
      ) : null}
      {data && !receiveId && (
        <>
          {created?.receiveId ? (
            <CreatedSlip
              api={api}
              created={created}
              assets={data.assets}
              onAgain={() => setCreated(null)}
              onChanged={bump}
            />
          ) : (
            <RequestForm
              api={api}
              assets={data.assets}
              like={like}
              onCreated={(r) => {
                setCreated(r);
                bump();
              }}
            />
          )}
          <WhoOwesYou api={api} assets={data.assets} tick={tick} />
        </>
      )}
    </section>
  );
}

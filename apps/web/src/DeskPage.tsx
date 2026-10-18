import { type DragEvent, useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import {
  type DeskLatelyItem,
  type DeskNeedsKind,
  type DeskResponse,
  formatAssetAmount,
  OWL_NAME,
} from './api/contracts.js';
import {
  balanceSentence,
  DESK_MOODS,
  dateLine,
  deskMood,
  greeting,
  groupDigits,
  latelyHref,
  monthLine,
  orderNeeds,
} from './lib/desk.js';
import { shortDate } from './lib/format.js';
import { Stamp, type StampKind } from './Stamp.js';
import { Empty, ErrorBox, errorText, Loading, OwlChip, useLoad } from './ui.js';

const NEEDS_BADGE: Record<DeskNeedsKind, { tone: 'ok' | 'review' | 'block' | 'info'; icon: string; word: string }> = {
  awaiting_confirmation: { tone: 'ok', icon: '✓', word: 'Ready' },
  review_verdict: { tone: 'review', icon: '!', word: 'Check' },
  due_soon: { tone: 'review', icon: '!', word: 'Due soon' },
  scheduled_today: { tone: 'info', icon: 'i', word: 'Today' },
  request_expiring: { tone: 'review', icon: '!', word: 'Expiring' },
  low_fee_balance: { tone: 'review', icon: '!', word: 'Low on fees' },
  no_fee_money: { tone: 'block', icon: '✕', word: 'No fee money' },
  health_problem: { tone: 'review', icon: '!', word: 'Problem' },
};

const LATELY: Record<DeskLatelyItem['kind'], { stamp: StampKind; sign: '+' | '−' | '' }> = {
  paid: { stamp: 'PAID', sign: '−' },
  received: { stamp: 'RECEIVED', sign: '+' },
  blocked: { stamp: 'STOPPED', sign: '' },
  scheduled: { stamp: 'SCHEDULED', sign: '' },
  checked: { stamp: 'CHECKED', sign: '' },
};

type Balances = DeskResponse['balances'];
const amountOf = (amount: string | undefined, assetId: string | undefined, balances: Balances): string => {
  const b = balances.find((x) => x.assetId === assetId);
  return amount && b ? `${groupDigits(formatAssetAmount(amount, b.precision))} ${b.ticker}` : '';
};

/** Pay door: drop an invoice right on the Desk, or paste a payment request. I start reading and the invoice opens. */
function PayDoor({ api }: { api: ApiClient }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  async function take(input: Parameters<ApiClient['createInvoice']>[0] | undefined) {
    if (!input) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.createInvoice(input);
      window.location.hash = `#/invoice/${encodeURIComponent(res.invoiceId)}`;
    } catch (err) {
      setError(errorText(err, 'I could not take that. Check it and try again.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wl-door">
      <strong>Pay</strong>
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
          const file = e.dataTransfer.files?.[0];
          if (file) void take({ file });
        }}
      >
        <span>
          {busy ? 'Reading it… (about 30 seconds on this computer)' : 'Drop the invoice here, or click to choose it'}
        </span>
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.xml"
          className="wl-visually-hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void take({ file });
          }}
        />
      </label>
      {pasting ? (
        <div>
          <label className="wl-field" style={{ margin: 0 }}>
            <span className="wl-label">Paste the payment request</span>
            <textarea
              rows={3}
              style={{ width: '100%' }}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="rgb:… or lightning:…"
            />
          </label>
          <button
            type="button"
            disabled={busy || !pasted.trim()}
            onClick={() => void take({ text: pasted.trim(), filename: 'payment-request.txt' })}
          >
            Read it
          </button>
        </div>
      ) : (
        <button type="button" className="wl-linkbutton" onClick={() => setPasting(true)}>
          or paste a payment request
        </button>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--wl-c-error)', margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}

function NeedsRow({ n, balances }: { n: DeskResponse['needsYou'][number]; balances: Balances }) {
  const kindBadge = NEEDS_BADGE[n.kind];
  const b = n.tone ? { ...kindBadge, tone: n.tone } : kindBadge;
  const amount = amountOf(n.amount, n.assetId, balances);
  return (
    <li>
      <span className="wl-badge" data-tone={b.tone}>
        <span aria-hidden="true">{b.icon}</span> {b.word}
      </span>
      <span>{n.title}</span>
      <span className="num">{amount}</span>
      <a href={n.action.href} className="wl-secondary">
        {n.actionLabel ?? n.action.label}
      </a>
    </li>
  );
}

function LatelyRow({ l, balances }: { l: DeskLatelyItem; balances: Balances }) {
  const k = LATELY[l.kind];
  const stamp = l.stamp ?? k.stamp;
  const sign = l.direction ? ({ in: '+', out: '−', none: '' } as const)[l.direction] : k.sign;
  const amount = amountOf(l.amount, l.assetId, balances);
  return (
    <li>
      <Stamp kind={stamp} />
      <a href={latelyHref(l)} className="what">
        {l.title}
        <small>{shortDate(l.at)}</small>
      </a>
      <span className={`num ${sign === '+' ? 'wl-in' : 'wl-out'}`}>{amount && `${sign} ${amount}`}</span>
    </li>
  );
}

/** `#/`: the Money Desk. What needs the user today, from real data only. */
export function DeskPage({ api }: { api: ApiClient }) {
  const load = useCallback(() => api.desk(), [api]);
  const { data, error, loading, reload } = useLoad(load);
  const mood = data ? deskMood(data) : undefined;
  // The chip follows real work: refresh faster while I am busy, slowly otherwise.
  useEffect(() => {
    if (!mood) return;
    const id = setInterval(reload, mood === 'busy' ? 3000 : 20_000);
    return () => clearInterval(id);
  }, [mood, reload]);
  const month = data ? monthLine(data.month, data.balances) : null;
  const dated = data ? dateLine(new Date(), data.updated, data.syncedAt) : null;

  return (
    <section>
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
      {data && mood && dated && (
        <>
          <div className="wl-talk">
            <OwlChip mood="all_good" size={48} chip={DESK_MOODS[mood]} />
            <div className="wl-bubble">
              <h2>{greeting(data.greetingCounts.needsYou)}</h2>
              <p>{balanceSentence(data)}</p>
            </div>
          </div>
          <p className="wl-dateline" data-stale={dated.stale}>
            {dated.text}
          </p>
          {month && <p className="wl-month">{month}</p>}

          <div className="wl-doors">
            <PayDoor api={api} />
            <div className="wl-door">
              <strong>Get paid</strong>
              <span>Ask someone who owes you for money.</span>
              <a className="wl-button" href="#/get-paid">
                Ask for money
              </a>
            </div>
          </div>

          <h3>Needs you</h3>
          {data.needsYou.length === 0 ? (
            <Empty text="Nothing needs you right now. I will tell you here when something does." />
          ) : (
            <ul className="wl-needs" aria-label="Needs you">
              {orderNeeds(data.needsYou).map((n) => (
                <NeedsRow key={`${n.kind}-${n.id}`} n={n} balances={data.balances} />
              ))}
            </ul>
          )}

          <h3>Lately</h3>
          {data.lately.length === 0 ? (
            <Empty text="Nothing yet. Pay or send your first invoice." />
          ) : (
            <ul className="wl-ledger-list" aria-label="Lately">
              {data.lately.slice(0, 5).map((l) => (
                <LatelyRow key={`${l.kind}-${l.id}`} l={l} balances={data.balances} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

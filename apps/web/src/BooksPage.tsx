import { Fragment, useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { type BookRow, bookRows } from './lib/books.js';
import { payees } from './lib/desk.js';
import { shortDate } from './lib/format.js';
import { ReceiptCard } from './ReceiptCard.js';
import { FiscalForm } from './TransfersPage.js';
import { LabelCell } from './TransfersTable.js';
import { Empty, ErrorBox, errorText, Loading, useLoad } from './ui.js';

const PAGE = 20;

/** Date | What | In | Out | Balance, newest first, on ruled lines like accounting paper. */
export function Ledger({
  api,
  rows,
  more,
}: {
  api: ApiClient;
  rows: readonly BookRow[];
  /** Loads the next page; absent when there is no more. */
  more?: (() => Promise<void>) | undefined;
}) {
  const [receipt, setReceipt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table className="wl-ledger" data-testid="ledger">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">What</th>
              <th scope="col" className="num">
                In
              </th>
              <th scope="col" className="num">
                Out
              </th>
              <th scope="col" className="num">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.key}>
                <BookLine
                  api={api}
                  r={r}
                  open={receipt === r.key}
                  onReceipt={() => setReceipt(receipt === r.key ? null : r.key)}
                />
                {receipt === r.key && r.transferId && (
                  <tr>
                    <td colSpan={5}>
                      <ReceiptCard api={api} transferId={r.transferId} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {more && (
        <button
          type="button"
          className="wl-secondary"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              await more();
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? 'Loading…' : 'Show more'}
        </button>
      )}
    </>
  );
}

/** One ledger line. Pending lines are italic with the word "pending" and no balance yet. */
export function BookLine({
  api,
  r,
  open,
  onReceipt,
}: {
  api: ApiClient;
  r: BookRow;
  open: boolean;
  onReceipt: () => void;
}) {
  return (
    <tr data-pending={r.pending}>
      <td style={{ whiteSpace: 'nowrap' }}>{shortDate(r.at)}</td>
      <td>
        {r.invoiceId ? <a href={`#/invoice/${encodeURIComponent(r.invoiceId)}`}>{r.what}</a> : r.what}
        {r.transferId && <LabelCell api={api} transferId={r.transferId} initial={r.labels} />}
        {r.canReceipt && (
          <button type="button" className="wl-quiet" aria-expanded={open} onClick={onReceipt}>
            {open ? 'Hide receipt' : 'Receipt'}
          </button>
        )}
      </td>
      <td className="num wl-in">{r.in ? `+ ${r.in}` : ''}</td>
      <td className="num wl-out">{r.out ? `− ${r.out}` : ''}</td>
      <td className="num">{r.pending ? 'pending' : r.failed ? 'failed' : (r.balance ?? '')}</td>
    </tr>
  );
}

/** `#/books`: everything in and out like a ledger, the people you pay, and the report for your accountant. */
export function BooksPage({ api }: { api: ApiClient }) {
  const [rows, setRows] = useState<BookRow[] | null>(null);
  const [next, setNext] = useState<string | undefined>();
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const loadPayees = useCallback(async () => payees((await api.listInvoices()).invoices), [api]);
  const people = useLoad(loadPayees);

  useEffect(() => {
    void tick;
    let live = true;
    api.books({ limit: PAGE }).then(
      (res) => {
        if (!live) return;
        setRows(bookRows(res));
        setNext(res.nextBefore);
        setError(null);
      },
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [api, tick]);

  const more = next
    ? async () => {
        const res = await api.books({ limit: PAGE, before: next });
        setRows((cur) => [...(cur ?? []), ...bookRows(res)]);
        setNext(res.nextBefore);
      }
    : undefined;

  return (
    <section>
      <h2>Books</h2>
      {error ? (
        <ErrorBox
          error={errorText(error, 'I could not open your books. Try again in a moment.')}
          retry={() => setTick((n) => n + 1)}
        />
      ) : null}
      {!rows && !error ? <Loading text="Opening your books…" /> : null}
      {rows && (
        <>
          <h3>Money in and out</h3>
          {rows.length === 0 ? (
            <Empty text="Nothing yet. Pay or send your first invoice." />
          ) : (
            <Ledger api={api} rows={rows} more={more} />
          )}

          <h3>People you pay</h3>
          {!people.data || people.data.length === 0 ? (
            <Empty text="Nobody yet. Suppliers you have paid show up here." />
          ) : (
            <ul className="wl-list" aria-label="People you pay">
              {people.data.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong>
                  <span>
                    {p.times} {p.times === 1 ? 'payment' : 'payments'} · last {p.lastTotal ?? '?'}{' '}
                    {p.lastCurrency ?? ''}, {shortDate(p.lastAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <FiscalForm api={api} />
        </>
      )}
    </section>
  );
}

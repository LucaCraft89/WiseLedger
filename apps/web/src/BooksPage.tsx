import { useCallback } from 'react';
import type { ApiClient } from './api/client.js';
import { payees } from './lib/desk.js';
import { shortDate } from './lib/format.js';
import { recentTransfers } from './lib/ledger.js';
import { FiscalForm } from './TransfersPage.js';
import { TransfersTable } from './TransfersTable.js';
import { Empty, ErrorBox, errorText, Loading, useLoad } from './ui.js';

/** `#/books`: everything in and out with labels, the people you pay, and the report for your accountant. */
export function BooksPage({ api }: { api: ApiClient }) {
  const load = useCallback(async () => {
    const [t, w, i] = await Promise.all([api.transfers(), api.wallet(), api.listInvoices()]);
    return {
      transfers: recentTransfers(t.transfers, Number.POSITIVE_INFINITY),
      assets: w.assets,
      payees: payees(i.invoices),
    };
  }, [api]);
  const { data, error, loading, reload } = useLoad(load);

  return (
    <section>
      <h2>Books</h2>
      {error ? (
        <ErrorBox error={errorText(error, 'I could not open your books. Try again in a moment.')} retry={reload} />
      ) : null}
      {loading && !data ? <Loading text="Opening your books…" /> : null}
      {data && (
        <>
          <h3>Money in and out</h3>
          {data.transfers.length === 0 ? (
            <Empty text="Nothing yet. Pay or send your first invoice." />
          ) : (
            <TransfersTable api={api} transfers={data.transfers} assets={data.assets} />
          )}

          <h3>People you pay</h3>
          {data.payees.length === 0 ? (
            <Empty text="Nobody yet. Suppliers you have paid show up here." />
          ) : (
            <ul className="wl-list" aria-label="People you pay">
              {data.payees.map((p) => (
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

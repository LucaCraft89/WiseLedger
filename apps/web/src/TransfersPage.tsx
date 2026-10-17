import { useCallback, useState } from 'react';
import type { ApiClient } from './api/client.js';
import type { FiscalQuery } from './api/contracts.js';
import { defaultFiscalRange, fiscalFilename, fiscalRangeError, recentTransfers } from './lib/ledger.js';
import { TransfersTable } from './TransfersTable.js';
import { Empty, ErrorBox, Loading, useLoad, useToast } from './ui.js';

const box = { border: '1px solid var(--wl-c-line)', borderRadius: 6, padding: 12, marginBottom: 16 } as const;

/** #/transfers: every transfer with labels, plus the fiscal report download. */
export function TransfersPage({ api }: { api: ApiClient }) {
  const load = useCallback(async () => {
    const [t, w] = await Promise.all([api.transfers(), api.wallet()]);
    return { transfers: recentTransfers(t.transfers, Number.POSITIVE_INFINITY), assets: w.assets };
  }, [api]);
  const { data, error, loading, reload } = useLoad(load);

  return (
    <section>
      <h2>Transfers</h2>
      <p>
        <a href="#/wallet">← Back to the wallet</a>{' '}
        <button className="wl-quiet" type="button" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </p>
      {error ? <ErrorBox error={error} retry={reload} /> : null}
      {loading && !data ? <Loading text="Loading transfers…" /> : null}
      {data && data.transfers.length === 0 && <Empty text="No transfers yet." />}
      {data && data.transfers.length > 0 && (
        <TransfersTable api={api} transfers={data.transfers} assets={data.assets} />
      )}
      <FiscalForm api={api} />
    </section>
  );
}

/** Date range + format → download the fiscal report (a file from the server). */
export function FiscalForm({ api }: { api: ApiClient }) {
  const toast = useToast();
  const [range, setRange] = useState(() => defaultFiscalRange());
  const [format, setFormat] = useState<FiscalQuery['format']>('csv');
  const problem = fiscalRangeError(range.from, range.to);
  const q: FiscalQuery = { ...range, format };
  const url = problem ? null : api.fiscalUrl(q);

  return (
    <div style={box}>
      <h3 style={{ marginTop: 0 }}>Fiscal report</h3>
      <p style={{ marginTop: 0 }}>All transfers in a period, with labels, for your accountant.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <label>
          From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </label>
        <label>
          To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </label>
        <label>
          Format{' '}
          <select value={format} onChange={(e) => setFormat(e.target.value === 'json' ? 'json' : 'csv')}>
            <option value="csv">CSV (spreadsheet)</option>
            <option value="json">JSON</option>
          </select>
        </label>
        {problem ? (
          <button type="button" disabled>
            Download
          </button>
        ) : url ? (
          <a href={url} download={fiscalFilename(q)} style={{ fontWeight: 'bold' }}>
            Download
          </a>
        ) : (
          <button type="button" onClick={() => toast('Report ready (demo mode)', 'success')}>
            Download
          </button>
        )}
      </div>
      {problem && <p style={{ color: 'var(--wl-c-error)', marginBottom: 0 }}>{problem}</p>}
    </div>
  );
}

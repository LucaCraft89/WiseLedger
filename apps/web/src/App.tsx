import { useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { selectClient } from './api/select.js';
import { InvoicePage } from './InvoicePage.js';
import { UploadPage } from './UploadPage.js';

/** Hash routing: `#/` = upload, `#/invoice/<id>` = invoice page. */
function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const [api, setApi] = useState<ApiClient | null>(null);
  const hash = useHashRoute();

  useEffect(() => {
    void selectClient().then(setApi);
  }, []);

  if (!api) return <p style={{ padding: 24 }}>Starting WiseLedger…</p>;

  const invoiceId = hash.match(/^#\/invoice\/(.+)$/)?.[1];
  return (
    <main
      style={{ maxWidth: 720, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif', lineHeight: 1.5 }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>
          <a href="#/" style={{ color: 'inherit', textDecoration: 'none' }}>
            WiseLedger
          </a>
        </h1>
        {api.mode === 'fake' && (
          <span style={{ background: '#fff3cd', padding: '2px 8px', borderRadius: 4 }}>
            Demo mode: no server, nothing is really paid
          </span>
        )}
      </header>
      {invoiceId ? (
        <InvoicePage key={invoiceId} api={api} invoiceId={decodeURIComponent(invoiceId)} />
      ) : (
        <UploadPage api={api} onCreated={(id) => (window.location.hash = `#/invoice/${encodeURIComponent(id)}`)} />
      )}
    </main>
  );
}

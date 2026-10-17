import { useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { selectClient } from './api/select.js';
import { ChatPage } from './ChatPage.js';
import { InvoiceListPage } from './InvoiceListPage.js';
import { InvoicePage } from './InvoicePage.js';
import { SchedulePage } from './SchedulePage.js';
import { SettingsDrawer } from './SettingsDrawer.js';
import { TransfersPage } from './TransfersPage.js';
import { UploadPage } from './UploadPage.js';
import { WalletPage } from './WalletPage.js';

/**
 * Hash routing: `#/` = upload, `#/invoices` = list, `#/invoice/<id>` = invoice page, `#/wallet` = wallet,
 * `#/transfers` = transfers + fiscal report, `#/schedule` = scheduled payments, `#/chat` = Treasurer chat.
 */
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
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void selectClient().then(setApi);
  }, []);

  if (!api) return <p style={{ padding: 24 }}>Starting WiseLedger…</p>;

  const invoiceId = hash.match(/^#\/invoice\/(.+)$/)?.[1];
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <header
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}
      >
        <h1 style={{ margin: 0 }}>
          <a
            href="#/"
            style={{ color: 'inherit', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 10 }}
          >
            <img src="/brand/owl-192.png" width={40} height={40} alt="" />
            WiseLedger
          </a>
        </h1>
        <nav style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <a href="#/">Check an invoice</a>
          <a href="#/invoices">My invoices</a>
          <a href="#/wallet">Wallet</a>
          <a href="#/schedule">Scheduled</a>
          <a href="#/chat">Ask the Treasurer</a>
          <button type="button" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </nav>
      </header>
      {api.mode === 'fake' && (
        <p style={{ background: '#fff3cd', padding: '2px 8px', borderRadius: 4 }}>
          Demo mode: no server, nothing is really paid
        </p>
      )}
      {invoiceId ? (
        <InvoicePage key={invoiceId} api={api} invoiceId={decodeURIComponent(invoiceId)} />
      ) : hash === '#/wallet' ? (
        <WalletPage api={api} />
      ) : hash === '#/transfers' ? (
        <TransfersPage api={api} />
      ) : hash === '#/schedule' ? (
        <SchedulePage api={api} />
      ) : hash === '#/chat' ? (
        <ChatPage api={api} />
      ) : hash === '#/invoices' ? (
        <InvoiceListPage api={api} />
      ) : (
        <UploadPage api={api} onCreated={(id) => (window.location.hash = `#/invoice/${encodeURIComponent(id)}`)} />
      )}
      {settingsOpen && <SettingsDrawer api={api} onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}

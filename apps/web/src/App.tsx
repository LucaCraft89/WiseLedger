import { useCallback, useEffect, useState } from 'react';
import { type ApiClient, READY_ONBOARDING } from './api/client.js';
import type { OnboardingStatusResponse } from './api/contracts.js';
import { selectClient } from './api/select.js';
import { ChatPage } from './ChatPage.js';
import { GettingStarted } from './GettingStarted.js';
import { InvoiceListPage } from './InvoiceListPage.js';
import { InvoicePage } from './InvoicePage.js';
import { screenForOnboarding } from './lib/onboarding.js';
import { SetupScreen, UnlockScreen } from './OnboardingScreens.js';
import { SchedulePage } from './SchedulePage.js';
import { SettingsPage } from './SettingsPage.js';
import { ThemeSwitch } from './ThemeSwitch.js';
import { TransfersPage } from './TransfersPage.js';
import { UploadPage } from './UploadPage.js';
import { WalletPage } from './WalletPage.js';

/**
 * Hash routing: `#/` = upload, `#/invoices` = list, `#/invoice/<id>` = invoice page, `#/wallet` = wallet,
 * `#/transfers` = transfers + fiscal report, `#/schedule` = scheduled payments, `#/chat` = Treasurer chat,
 * `#/settings` = settings and the Local AI panel. Before the wallet is set up (or while it is locked) the
 * first-run screens replace every route.
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

const NAV = [
  { href: '#/', label: 'Check an invoice' },
  { href: '#/invoices', label: 'My invoices' },
  { href: '#/wallet', label: 'Wallet' },
  { href: '#/schedule', label: 'Scheduled' },
  { href: '#/chat', label: 'Ask the Treasurer' },
  { href: '#/settings', label: 'Settings' },
] as const;

function isCurrent(href: string, hash: string): boolean {
  if (href === '#/') return hash === '' || hash === '#' || hash === '#/';
  return hash === href || (href === '#/invoices' && hash.startsWith('#/invoice/'));
}

export function App() {
  const [api, setApi] = useState<ApiClient | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStatusResponse | null>(null);
  const hash = useHashRoute();

  const checkOnboarding = useCallback(async (client: ApiClient) => {
    // A server that cannot answer here still gets the normal pages, which show their own plain errors.
    setOnboarding(await client.onboarding().catch(() => READY_ONBOARDING));
  }, []);

  useEffect(() => {
    void selectClient().then(async (client) => {
      await checkOnboarding(client);
      setApi(client);
    });
  }, [checkOnboarding]);

  if (!api || !onboarding) {
    return (
      <p role="status" style={{ padding: 24 }}>
        Starting WiseLedger…
      </p>
    );
  }

  const screen = screenForOnboarding(onboarding.state);
  const invoiceId = hash.match(/^#\/invoice\/(.+)$/)?.[1];
  const home = hash === '' || hash === '#' || hash === '#/';
  return (
    <>
      <a href="#main" className="wl-skip">
        Skip to content
      </a>
      <div className="wl-shell">
        <header className="wl-header">
          <h1 style={{ margin: 0 }}>
            <a
              href="#/"
              style={{
                color: 'inherit',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <img src="/brand/owl-192.png" width={40} height={40} alt="" />
              WiseLedger
            </a>
          </h1>
          {screen === 'app' && (
            <nav aria-label="Main" className="wl-nav">
              {NAV.map((n) => (
                <a key={n.href} href={n.href} aria-current={isCurrent(n.href, hash) ? 'page' : undefined}>
                  {n.label}
                </a>
              ))}
            </nav>
          )}
          <ThemeSwitch />
        </header>
        {api.mode === 'fake' && (
          <p role="note" style={{ background: 'var(--wl-review-bg)', padding: '2px 8px', borderRadius: 4 }}>
            Demo mode: no server, nothing is really paid
          </p>
        )}
        <main id="main" tabIndex={-1}>
          {screen === 'setup' ? (
            <SetupScreen api={api} status={onboarding} onDone={() => void checkOnboarding(api)} />
          ) : screen === 'unlock' ? (
            <UnlockScreen api={api} onDone={() => void checkOnboarding(api)} />
          ) : (
            <>
              {!onboarding.seedShown && (
                <p role="note" className="wl-card" style={{ background: 'var(--wl-review-bg)' }}>
                  Reminder: your recovery words were not saved yet. Without them this wallet cannot be restored if this
                  computer breaks.
                </p>
              )}
              {invoiceId ? (
                <InvoicePage key={invoiceId} api={api} invoiceId={decodeURIComponent(invoiceId)} />
              ) : hash === '#/wallet' ? (
                <>
                  <GettingStarted api={api} />
                  <WalletPage api={api} />
                </>
              ) : hash === '#/transfers' ? (
                <TransfersPage api={api} />
              ) : hash === '#/schedule' ? (
                <SchedulePage api={api} />
              ) : hash === '#/chat' ? (
                <ChatPage api={api} />
              ) : hash === '#/invoices' ? (
                <InvoiceListPage api={api} />
              ) : hash === '#/settings' ? (
                <SettingsPage api={api} />
              ) : (
                <>
                  {home && <GettingStarted api={api} />}
                  <UploadPage
                    api={api}
                    onCreated={(id) => (window.location.hash = `#/invoice/${encodeURIComponent(id)}`)}
                  />
                </>
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { type ApiClient, READY_ONBOARDING } from './api/client.js';
import type { OnboardingStatusResponse } from './api/contracts.js';
import { connectServer, demoClient, demoRequested } from './api/select.js';
import { BooksPage } from './BooksPage.js';
import { ChatPage } from './ChatPage.js';
import { DeskPage } from './DeskPage.js';
import { GetPaidPage } from './GetPaidPage.js';
import { GettingStarted } from './GettingStarted.js';
import { IntroCards } from './IntroCards.js';
import { InvoiceListPage } from './InvoiceListPage.js';
import { InvoicePage } from './InvoicePage.js';
import { introSeen, screenForOnboarding } from './lib/onboarding.js';
import { NAV, redirectFor, sectionOf } from './lib/routes.js';
import { SetupScreen, UnlockScreen } from './OnboardingScreens.js';
import { SchedulePage } from './SchedulePage.js';
import { SettingsPage } from './SettingsPage.js';
import { ThemeSwitch } from './ThemeSwitch.js';
import { UploadPage } from './UploadPage.js';
import { MoneyPage } from './WalletPage.js';

/**
 * Hash routing: `#/` = Desk, `#/pay` (+ `/invoices`, `/scheduled`) = pay, `#/invoice/<id>` = one invoice,
 * `#/get-paid` = payment requests, `#/books` = transfers, payees, fiscal report, `#/ask` = chat with Wise,
 * `#/settings` (+ `/money`) = settings. Old hashes redirect (lib/routes.ts). Before the wallet is set up (or while it
 * is locked) the first-run screens replace every route.
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

function isCurrent(href: string, hash: string): boolean {
  return sectionOf(hash) === href;
}

export function App() {
  const [api, setApi] = useState<ApiClient | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingStatusResponse | null>(null);
  const [introDone, setIntroDone] = useState(introSeen);
  const rawHash = useHashRoute();
  const redirect = redirectFor(rawHash);
  const hash = redirect ?? rawHash;
  useEffect(() => {
    if (redirect) window.location.replace(redirect);
  }, [redirect]);

  const checkOnboarding = useCallback(async (client: ApiClient) => {
    // A server that cannot answer here still gets the normal pages, which show their own plain errors.
    setOnboarding(await client.onboarding().catch(() => READY_ONBOARDING));
  }, []);

  const [waiting, setWaiting] = useState(0);
  const adopt = useCallback(
    async (client: ApiClient) => {
      await checkOnboarding(client);
      setApi(client);
    },
    [checkOnboarding],
  );

  useEffect(() => {
    if (demoRequested()) {
      void adopt(demoClient());
      return;
    }
    const stop = new AbortController();
    connectServer(setWaiting, { signal: stop.signal })
      .then(adopt)
      .catch(() => undefined);
    return () => stop.abort();
  }, [adopt]);

  if (!api || !onboarding) {
    if (waiting === 0) {
      return (
        <p role="status" style={{ padding: 24 }}>
          Starting WiseLedger…
        </p>
      );
    }
    return (
      <section role="status" aria-live="polite" style={{ padding: 24, maxWidth: 640 }}>
        <h2>Server not reachable, retrying…</h2>
        <p>
          WiseLedger's server on this computer is not answering yet (attempt {waiting}). If you just started it, wait a
          few seconds: it opens the wallet and the local AI first.
        </p>
        <p style={{ color: 'var(--wl-c-muted)' }}>
          Not started? Run <code>pnpm dev</code> in the project folder. Nothing is paid or analysed until it answers.
        </p>
        <button type="button" className="wl-secondary" onClick={() => void adopt(demoClient())}>
          Open the demo without a server (nothing is real)
        </button>
      </section>
    );
  }

  const screen = screenForOnboarding(onboarding.state);
  const invoiceId = hash.match(/^#\/invoice\/(.+)$/)?.[1];
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
          <ThemeSwitch />
          {screen === 'app' && (
            <nav aria-label="Main" className="wl-nav">
              {NAV.map((n) => (
                <a key={n.href} href={n.href} aria-current={isCurrent(n.href, hash) ? 'page' : undefined}>
                  {n.label}
                </a>
              ))}
            </nav>
          )}
        </header>
        {api.mode === 'fake' && (
          <p role="note" style={{ background: 'var(--wl-review-bg)', padding: '2px 8px', borderRadius: 4 }}>
            Demo mode: no server, nothing is really paid
          </p>
        )}
        <main id="main" tabIndex={-1}>
          {screen === 'setup' && !introDone ? (
            <IntroCards onDone={() => setIntroDone(true)} />
          ) : screen === 'setup' ? (
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
              ) : hash.startsWith('#/get-paid') ? (
                <>
                  <GetPaidPage api={api} hash={hash} />
                  <GettingStarted api={api} />
                </>
              ) : hash === '#/books' ? (
                <BooksPage api={api} />
              ) : hash === '#/pay/scheduled' ? (
                <SchedulePage api={api} />
              ) : hash === '#/pay/invoices' ? (
                <InvoiceListPage api={api} />
              ) : hash === '#/pay' ? (
                <UploadPage
                  api={api}
                  onCreated={(id) => (window.location.hash = `#/invoice/${encodeURIComponent(id)}`)}
                />
              ) : hash === '#/ask' ? (
                <ChatPage api={api} />
              ) : hash === '#/settings/money' ? (
                <MoneyPage api={api} />
              ) : hash === '#/settings' ? (
                <SettingsPage api={api} />
              ) : (
                <>
                  <DeskPage api={api} />
                  <GettingStarted api={api} />
                </>
              )}
            </>
          )}
        </main>
      </div>
    </>
  );
}

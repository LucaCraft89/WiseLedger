import { useCallback, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { useLoad } from './ui.js';

const HIDE_KEY = 'wl-hide-getting-started';

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Hint text with its web addresses turned into links (faucet pages). */
export function HintText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <a key={i} href={p.replace(/[.,;]$/, '')} target="_blank" rel="noopener noreferrer">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

/**
 * "Getting started" checklist from the server's plain-language hints (faucet, test asset, first payment),
 * so a first-time user reaches a first payment from on-screen hints alone. Can be hidden (per browser).
 */
export function GettingStarted({ api, always = false }: { api: ApiClient; always?: boolean }) {
  const [hidden, setHidden] = useState(readHidden);
  const load = useCallback(() => api.health(), [api]);
  const { data } = useLoad(load);
  const hints = data?.hints ?? [];
  if (hints.length === 0 || (hidden && !always)) return null;
  return (
    <section className="wl-card" aria-labelledby="getting-started-title" style={{ marginBottom: 16 }}>
      <h3 id="getting-started-title" style={{ marginTop: 0 }}>
        Getting started
      </h3>
      <ol style={{ paddingLeft: 20, margin: '0 0 8px' }}>
        {hints.map((h) => (
          <li key={h} style={{ marginBottom: 6 }}>
            <HintText text={h} />
          </li>
        ))}
        <li>
          Then <a href="#/">check an invoice</a> and confirm the payment. It is done when the invoice page says{' '}
          <strong>Paid</strong>.
        </li>
      </ol>
      {!always && (
        <button
          type="button"
          className="wl-secondary"
          onClick={() => {
            try {
              localStorage.setItem(HIDE_KEY, '1');
            } catch {
              // storage blocked: hide for this visit only
            }
            setHidden(true);
          }}
        >
          Hide these tips
        </button>
      )}
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import type { HealthResponse } from './api/contracts.js';
import { GettingStarted } from './GettingStarted.js';
import { formatAiRun, lastAiRun, localAiSentence, MODEL_STATE_WORDS } from './lib/ai-stats.js';
import { describeHealth, formatDate } from './lib/format.js';
import { BACKEND_WORDS, NETWORK_WORDS } from './lib/live.js';
import { ErrorBox, errorText, Loading } from './ui.js';

const grid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 16,
  marginBottom: 16,
} as const;
const dl = { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 } as const;

/** While the model loads, check again every few seconds so "warm" shows up by itself. */
const LOADING_POLL_MS = 4000;

/** `#/settings`: Local AI panel, wallet and network, getting-started tips and the system status. */
export function SettingsPage({ api }: { api: ApiClient }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setHealth(await api.health());
    } catch (err) {
      setError(errorText(err, 'Could not check the system.'));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const loading = health?.llm.state === 'loading' || health?.llm.state === 'unloaded';
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => void load(), LOADING_POLL_MS);
    return () => clearInterval(t);
  }, [loading, load]);

  return (
    <section>
      <h2>Settings</h2>
      {api.mode === 'fake' && <p>Demo mode: no server is connected, nothing is really paid.</p>}
      {error && <ErrorBox error={error} retry={() => void load()} />}
      {!health && !error && <Loading text="Checking the system…" />}
      {health && (
        <>
          <div style={grid}>
            <LocalAiPanel llm={health.llm} />
            <section className="wl-card" aria-labelledby="wallet-info-title">
              <h3 id="wallet-info-title" style={{ marginTop: 0 }}>
                Wallet and network
              </h3>
              <dl style={dl}>
                <dt>Wallet</dt>
                <dd style={{ margin: 0 }}>{BACKEND_WORDS[health.wallet.backend]}</dd>
                <dt>Network</dt>
                <dd style={{ margin: 0 }}>{NETWORK_WORDS[health.network ?? health.wallet.network]}</dd>
                <dt>Status</dt>
                <dd style={{ margin: 0 }}>{health.wallet.ready ? 'ready' : 'not ready yet'}</dd>
                {health.wallet.blockHeight !== undefined && (
                  <>
                    <dt>Latest block</dt>
                    <dd style={{ margin: 0 }}>{health.wallet.blockHeight.toLocaleString()}</dd>
                  </>
                )}
              </dl>
              <p style={{ marginBottom: 0 }}>
                Every payment needs your OK. Your spending rules are checked before anything is sent.
              </p>
            </section>
          </div>

          <GettingStarted api={api} always />

          <section className="wl-card" aria-labelledby="status-title">
            <h3 id="status-title" style={{ marginTop: 0 }}>
              System status
            </h3>
            <p role="status">
              <strong>{describeHealth(health).overall}</strong>
            </p>
            <h4>Problems</h4>
            {health.problems.length === 0 ? (
              <p>None.</p>
            ) : (
              <ul>
                {health.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <p style={{ fontSize: 14, color: 'var(--wl-muted)' }}>Last checked: {formatDate(health.time)}</p>
            <button type="button" onClick={() => void load()}>
              Check again
            </button>
          </section>
        </>
      )}
    </section>
  );
}

/** Model name, warm state, speed of the last analysis, and where the AI runs, in one plain sentence. */
export function LocalAiPanel({ llm }: { llm: HealthResponse['llm'] }) {
  const run = lastAiRun();
  return (
    <section className="wl-card" aria-labelledby="local-ai-title" data-testid="local-ai">
      <h3 id="local-ai-title" style={{ marginTop: 0 }}>
        Local AI
      </h3>
      <p>
        <strong>{localAiSentence(llm)}</strong>
      </p>
      <dl style={dl}>
        <dt>Model</dt>
        <dd style={{ margin: 0 }}>{llm.model}</dd>
        <dt>State</dt>
        <dd style={{ margin: 0 }} aria-live="polite">
          {MODEL_STATE_WORDS[llm.state]}
          {llm.state === 'ready' && llm.warmUpMs !== undefined && ` (loaded in ${(llm.warmUpMs / 1000).toFixed(1)} s)`}
        </dd>
        <dt>Last analysis</dt>
        <dd style={{ margin: 0 }}>{run ? formatAiRun(run) : 'No invoice checked yet since this page opened.'}</dd>
      </dl>
    </section>
  );
}

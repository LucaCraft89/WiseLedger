import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import type { HealthResponse } from './api/contracts.js';
import { describeHealth, formatDate } from './lib/format.js';

/** Side panel with the server's health in plain words. */
export function SettingsDrawer({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setHealth(await api.health());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check the system.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const d = health ? describeHealth(health) : null;
  return (
    <aside
      aria-label="Settings"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(360px, 100vw)',
        boxSizing: 'border-box',
        background: '#fff',
        borderLeft: '1px solid #ccc',
        boxShadow: '-4px 0 12px rgba(0,0,0,0.15)',
        padding: 16,
        overflowY: 'auto',
        zIndex: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0 }}>Settings</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <h3>System status</h3>
      {api.mode === 'fake' && <p>Demo mode: no server is connected, nothing is really paid.</p>}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      {!health && !error && <p>Checking…</p>}
      {health && d && (
        <>
          <p>
            <strong>{d.overall}</strong>
          </p>
          <ul>
            <li>{d.ai}</li>
            <li>{d.wallet}</li>
          </ul>
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
          <p style={{ fontSize: '0.85em', color: '#555' }}>Last checked: {formatDate(health.time)}</p>
        </>
      )}
      <button type="button" onClick={() => void load()}>
        Check again
      </button>
    </aside>
  );
}

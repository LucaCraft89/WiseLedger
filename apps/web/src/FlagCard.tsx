import type { RiskFlag } from './api/contracts.js';
import { SEVERITY_COLORS } from './lib/format.js';
import { flagTitle, SEVERITY_ICON_WORD, shortEvidence } from './lib/payment.js';

const SEVERITY_ORDER = { block: 0, warn: 1, info: 2 } as const;

/** Most serious flags first. */
export const sortFlags = (flags: readonly RiskFlag[]): RiskFlag[] =>
  [...flags].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

/** One flag: colour bar + "Stop/Check/Info", a short title, the plain sentence and a quoted evidence snippet. */
export function FlagCard({ flag }: { flag: RiskFlag }) {
  const c = SEVERITY_COLORS[flag.severity];
  return (
    <li
      data-severity={flag.severity}
      data-code={flag.code}
      style={{
        background: c.bg,
        borderLeft: `6px solid ${c.border}`,
        borderRadius: 4,
        padding: '8px 12px',
        marginBottom: 8,
      }}
    >
      <div>
        <span
          style={{
            background: c.border,
            color: '#fff',
            fontWeight: 700,
            fontSize: '0.8em',
            padding: '1px 8px',
            borderRadius: 10,
            marginRight: 8,
          }}
        >
          {SEVERITY_ICON_WORD[flag.severity]}
        </span>
        <strong>{flagTitle(flag.code)}</strong>
      </div>
      <div>{flag.message}</div>
      {flag.evidence && (
        <div style={{ fontSize: '0.85em', marginTop: 4 }} title={flag.evidence}>
          What we saw:{' '}
          <q
            style={{
              fontFamily: 'ui-monospace, monospace',
              background: '#fff',
              border: '1px solid #ddd',
              borderRadius: 3,
              padding: '0 4px',
              wordBreak: 'break-word',
            }}
          >
            {shortEvidence(flag.evidence)}
          </q>
        </div>
      )}
    </li>
  );
}

export function FlagList({ flags }: { flags: readonly RiskFlag[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {sortFlags(flags).map((f) => (
        <FlagCard key={`${f.code}-${f.message}`} flag={f} />
      ))}
    </ul>
  );
}

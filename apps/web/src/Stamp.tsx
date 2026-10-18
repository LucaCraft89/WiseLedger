import { type ReactNode, useRef } from 'react';

export type StampKind =
  | 'PAID'
  | 'STOPPED'
  | 'CHECKED'
  | 'SCHEDULED'
  | 'RECEIVED'
  | 'OPEN'
  | 'ARRIVING'
  | 'EXPIRED'
  | 'CANCELLED';

/** State colours come from the brand tokens (ok / review / block / info). */
export const STAMP_TONE: Record<StampKind, 'ok' | 'review' | 'block' | 'info'> = {
  PAID: 'ok',
  RECEIVED: 'ok',
  CHECKED: 'ok',
  SCHEDULED: 'info',
  OPEN: 'info',
  ARRIVING: 'review',
  STOPPED: 'block',
  EXPIRED: 'info',
  CANCELLED: 'info',
};

/**
 * A rubber stamp made of CSS only: the word in a double border, tilted, slightly uneven. The word is real text and
 * the label, so a screen reader says it. `grow` fades and scales it in (CSS, 300 ms, off with reduced motion).
 */
export function Stamp({ kind, label, grow = false }: { kind: StampKind; label?: string; grow?: boolean }) {
  const word = label ?? kind;
  return (
    <span
      className={`wl-stamp${grow ? ' wl-stamp-grow' : ''}`}
      data-tone={STAMP_TONE[kind]}
      data-kind={kind}
      role="img"
      aria-label={word}
    >
      {word}
    </span>
  );
}

/** True only after `value` changed once this page was open: the stamp then animates in (not on first paint). */
export function useChangedTo<T>(value: T, target: T): boolean {
  const first = useRef(value);
  const seen = useRef(false);
  if (value !== first.current) seen.current = true;
  return seen.current && value === target;
}

export interface SlipRow {
  label: string;
  value: ReactNode;
}

/** The paper slip used by receipts and by the Get paid request: title, stamp, From / To / For rows, big amount. */
export function Slip({
  title,
  stamp,
  rows,
  amount,
  children,
}: {
  title: string;
  stamp: ReactNode;
  rows: readonly SlipRow[];
  amount: string;
  children?: ReactNode;
}) {
  return (
    <article className="wl-slip" aria-label={title}>
      <header className="wl-slip-head">
        <span className="wl-slip-title">{title}</span>
        {stamp}
      </header>
      <dl className="wl-slip-rows">
        {rows.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="wl-slip-amount">{amount}</p>
      {children}
    </article>
  );
}

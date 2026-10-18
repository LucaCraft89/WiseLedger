import type { RgbCheckLine } from './api/contracts.js';
import { flagAnchor } from './FlagCard.js';
import { VERDICT_ICON } from './lib/format.js';
import { sortCheckLines } from './lib/payment.js';

const RESULT_WORD: Record<RgbCheckLine['result'], string> = { ok: 'Passed', review: 'Check', block: 'Failed' };

/**
 * Every check on the RGB payment request, passed ones too, failures first. A failure that a flag card already
 * explains links to it instead of repeating it.
 */
export function RgbCheckCard({ lines }: { lines: readonly RgbCheckLine[] }) {
  const failing = lines.filter((l) => l.result !== 'ok').length;
  return (
    <section className="wl-card" data-testid="rgb-check" aria-labelledby="rgb-check-title" style={{ marginTop: 12 }}>
      <h4 id="rgb-check-title" style={{ marginTop: 0 }}>
        Payment request check
      </h4>
      <p style={{ marginTop: 0, color: 'var(--wl-c-muted)' }}>
        {failing === 0
          ? `All ${lines.length} checks on the supplier's payment request passed.`
          : `${failing} of ${lines.length} checks on the supplier's payment request need your attention.`}
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {sortCheckLines(lines).map((l) => (
          <li
            key={l.check}
            data-check={l.check}
            data-result={l.result}
            style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}
          >
            <span className="wl-badge" data-tone={l.result}>
              <span aria-hidden="true">{VERDICT_ICON[l.result]}</span> {RESULT_WORD[l.result]}
            </span>
            <span>
              {l.result !== 'ok' && l.flagCode ? (
                <a href={`#${flagAnchor(l.flagCode)}`} onClick={(e) => jumpTo(e, flagAnchor(l.flagCode ?? ''))}>
                  {l.text} See why below.
                </a>
              ) : (
                l.text
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The app routes on the hash (#/invoice/…): scroll to the flag without changing it.
function jumpTo(e: { preventDefault(): void }, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

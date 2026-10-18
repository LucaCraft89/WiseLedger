import { useState } from 'react';
import { INTRO_CARDS, markIntroSeen } from './lib/onboarding.js';
import { OwlChip } from './ui.js';

/** First run: the owl introduces itself in three short cards. Skip at any time; never shown again. */
export function IntroCards({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const last = i === INTRO_CARDS.length - 1;
  const finish = () => {
    markIntroSeen();
    onDone();
  };
  return (
    <section className="wl-card" aria-label="Meet Wise">
      <OwlChip mood="all_good" size={64} />
      <p className="wl-sayline">{INTRO_CARDS[i]}</p>
      <p style={{ color: 'var(--wl-c-muted)' }}>
        {i + 1} of {INTRO_CARDS.length}
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="button" onClick={last ? finish : () => setI(i + 1)}>
          {last ? 'Set up my wallet' : 'Next'}
        </button>
        {!last && (
          <button type="button" className="wl-secondary" onClick={finish}>
            Skip
          </button>
        )}
      </div>
    </section>
  );
}

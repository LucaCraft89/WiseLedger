import { useId, useState } from 'react';
import { ApiCallError, type ApiClient } from './api/client.js';
import type { OnboardingStatusResponse } from './api/contracts.js';
import { NETWORK_WORDS } from './lib/live.js';
import { checkWord, mnemonicProblem, normalizeMnemonic, passphraseProblem, pickCheckIndex } from './lib/onboarding.js';
import { errorText } from './ui.js';

const card = { maxWidth: 640, margin: '24px auto' } as const;
const field = { display: 'block', marginBottom: 12 } as const;
const fullInput = { display: 'block', width: '100%', marginTop: 4 } as const;

function FormError({ text }: { text: string | null }) {
  return (
    <p role="alert" style={{ color: 'var(--wl-block-text)', minHeight: '1.5em', margin: '8px 0' }}>
      {text ?? ''}
    </p>
  );
}

function PassphraseFields({
  min,
  value,
  repeat,
  onChange,
  onRepeat,
  purpose,
}: {
  min: number;
  value: string;
  repeat?: string;
  onChange: (v: string) => void;
  onRepeat?: (v: string) => void;
  purpose: string;
}) {
  const hint = useId();
  return (
    <fieldset style={{ border: '1px solid var(--wl-line)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <legend>Passphrase (optional)</legend>
      <p id={hint} style={{ marginTop: 0 }}>
        {purpose} {min > 0 ? `At least ${min} characters.` : ''} Leave it empty for no passphrase.
      </p>
      <label style={field}>
        Passphrase
        <input
          type="password"
          autoComplete="new-password"
          aria-describedby={hint}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={fullInput}
        />
      </label>
      {onRepeat && (
        <label style={field}>
          Type the passphrase again
          <input
            type="password"
            autoComplete="new-password"
            value={repeat ?? ''}
            onChange={(e) => onRepeat(e.target.value)}
            style={fullInput}
          />
        </label>
      )}
    </fieldset>
  );
}

type SetupStep =
  | { s: 'choose' }
  | { s: 'create' }
  | { s: 'restore' }
  | { s: 'words'; words: string[] }
  | { s: 'check'; words: string[]; index: number }
  | { s: 'restored'; note?: string };

/**
 * First run: create a new wallet (recovery words shown ONCE, then a check) or restore one from 12/24 words.
 * The words live only in this component's memory and are dropped as soon as the user confirms.
 */
export function SetupScreen({
  api,
  status,
  onDone,
}: {
  api: ApiClient;
  status: OnboardingStatusResponse;
  onDone: () => void;
}) {
  const [step, setStep] = useState<SetupStep>({ s: 'choose' });
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [phrase, setPhrase] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (next: SetupStep) => {
    setError(null);
    setStep(next);
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, 'That did not work. Check what you typed and try again.'));
    } finally {
      setBusy(false);
    }
  }

  const min = status.minPassphrase;

  return (
    <section className="wl-card" style={card} aria-labelledby="setup-title">
      <h2 id="setup-title" style={{ marginTop: 0 }}>
        Set up your wallet
      </h2>
      <p>
        WiseLedger keeps your wallet on this computer. Network: {NETWORK_WORDS[status.network]}. Nothing here uses real
        money.
      </p>

      {step.s === 'choose' && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => go({ s: 'create' })}>
            Create a new wallet
          </button>
          <button type="button" className="wl-secondary" onClick={() => go({ s: 'restore' })}>
            Restore from 12 or 24 words
          </button>
        </div>
      )}

      {step.s === 'create' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const problem = passphraseProblem(pass, min, pass2);
            if (problem) return setError(problem);
            void run(async () => {
              const res = await api.onboardingCreate(pass ? { passphrase: pass } : {});
              setPass('');
              setPass2('');
              go({ s: 'words', words: res.words.length ? res.words : normalizeMnemonic(res.mnemonic) });
            });
          }}
        >
          <h3>New wallet</h3>
          <PassphraseFields
            min={min}
            value={pass}
            repeat={pass2}
            onChange={setPass}
            onRepeat={setPass2}
            purpose="It protects the wallet on this computer: you type it each time WiseLedger starts."
          />
          <FormError text={error} />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create my wallet'}
            </button>
            <button type="button" className="wl-secondary" onClick={() => go({ s: 'choose' })}>
              Back
            </button>
          </div>
        </form>
      )}

      {step.s === 'words' && (
        <div>
          <h3>Write down your recovery words</h3>
          <p role="note" style={{ background: 'var(--wl-review-bg)', padding: 12, borderRadius: 8 }}>
            <strong>Write these {step.words.length} words on paper, in this order.</strong> They are the only way to get
            your wallet back if this computer breaks. Anyone who sees them can take your funds. WiseLedger shows them
            only once and never saves them.
          </p>
          <ol className="wl-words" aria-label="Recovery words">
            {step.words.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity of a recovery word
              <li key={i}>
                <span className="wl-words-n">{i + 1}.</span> <strong>{w}</strong>
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => {
              setTyped('');
              go({ s: 'check', words: step.words, index: pickCheckIndex(step.words.length) });
            }}
          >
            I wrote these words down
          </button>
        </div>
      )}

      {step.s === 'check' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!checkWord(step.words, step.index, typed)) {
              return setError(`That is not word number ${step.index + 1}. Look at your paper and try again.`);
            }
            void run(async () => {
              await api.onboardingSeedConfirmed();
              setTyped('');
              setStep({ s: 'choose' }); // drops the words from memory
              onDone();
            });
          }}
        >
          <h3>Check your paper</h3>
          <label style={field}>
            Type word number {step.index + 1}
            <input
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={fullInput}
            />
          </label>
          <FormError text={error} />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button type="submit" disabled={busy || !typed.trim()}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
            <button type="button" className="wl-secondary" onClick={() => go({ s: 'words', words: step.words })}>
              Show the words again
            </button>
          </div>
        </form>
      )}

      {step.s === 'restore' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const problem = mnemonicProblem(phrase) ?? passphraseProblem(pass, min);
            if (problem) return setError(problem);
            void run(async () => {
              const res = await api.onboardingRestore({
                mnemonic: normalizeMnemonic(phrase).join(' '),
                ...(pass ? { passphrase: pass } : {}),
              });
              setPhrase('');
              setPass('');
              go({ s: 'restored', note: res.note });
            });
          }}
        >
          <h3>Restore a wallet</h3>
          <label style={field}>
            Your 12 or 24 recovery words, separated by spaces
            <textarea
              rows={4}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              style={fullInput}
            />
          </label>
          <PassphraseFields
            min={min}
            value={pass}
            onChange={setPass}
            purpose="It protects the wallet on this computer: you type it each time WiseLedger starts."
          />
          <FormError text={error} />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button type="submit" disabled={busy}>
              {busy ? 'Restoring…' : 'Restore my wallet'}
            </button>
            <button type="button" className="wl-secondary" onClick={() => go({ s: 'choose' })}>
              Back
            </button>
          </div>
        </form>
      )}

      {step.s === 'restored' && (
        <div role="status">
          <h3>Your wallet is restored</h3>
          {step.note && <p>{step.note}</p>}
          <p>Balances can take a few minutes to appear while the wallet catches up with the network.</p>
          <button type="button" onClick={onDone}>
            Open my wallet
          </button>
        </div>
      )}
    </section>
  );
}

/** Locked wallet: ask for the passphrase. Wrong passphrase and too many tries get their own plain message. */
export function UnlockScreen({ api, onDone }: { api: ApiClient; onDone: () => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="wl-card" style={card} aria-labelledby="unlock-title">
      <h2 id="unlock-title" style={{ marginTop: 0 }}>
        Unlock your wallet
      </h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.onboardingUnlock({ passphrase: pass });
            setPass('');
            onDone();
          } catch (err) {
            setError(
              err instanceof ApiCallError && err.code === 'WalletLocked' && err.status !== 429
                ? 'That passphrase is not right. Check it and try again.'
                : errorText(err, 'I could not unlock the wallet. Check the passphrase and try again.'),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label style={field}>
          Passphrase
          <input
            type="password"
            autoComplete="current-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            style={fullInput}
          />
        </label>
        <FormError text={error} />
        <button type="submit" disabled={busy || !pass}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      <p style={{ fontSize: 14, color: 'var(--wl-muted)' }}>
        Forgot it? Without the passphrase you can restore the wallet from your recovery words on a fresh setup.
      </p>
    </section>
  );
}

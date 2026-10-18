import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from './api/client.js';
import { type ChatResponse, OWL_NAME } from './api/contracts.js';
import { chatSession } from './lib/chat-session.js';
import {
  CHAT_SUGGESTIONS,
  type ChatTurn,
  confirmScheduleFromChat,
  fiscalFilename,
  fiscalFromToolCall,
  type NeedsConfirmation,
  type ToolCall,
  toolChipText,
  toolLink,
} from './lib/ledger.js';
import { receiveIdOf } from './lib/receive.js';
import { canRecordVoice, micErrorText, startRecording, VOICE_MAX_SECONDS, type VoiceRecording } from './lib/voice.js';
import { Markdown } from './Markdown.js';
import { ReceiveCard } from './ReceiveCard.js';
import { ErrorBox, errorText, useToast } from './ui.js';

const bubble = (role: ChatTurn['role']) =>
  ({
    alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
    background: role === 'user' ? 'var(--wl-c-bubble-user)' : 'var(--wl-c-bubble)',
    borderRadius: 8,
    padding: '8px 12px',
    maxWidth: '85%',
    whiteSpace: role === 'user' ? 'pre-wrap' : 'normal',
  }) as const;

/** #/ask: ask Wise (local AI with wallet tools). Spending always needs a confirmation card. */
export function ChatPage({ api }: { api: ApiClient }) {
  // The conversation lives outside this page (lib/chat-session): switching section never loses an answer.
  const { messages, busy, live, error: chatError } = useSyncExternalStore(chatSession.subscribe, chatSession.get);
  const [draft, setDraft] = useState('');
  const [micError, setError] = useState<unknown>(null);
  const error =
    micError ?? (chatError ? errorText(chatError, 'I did not answer. Wait a minute, then ask me again.') : null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [voiceHint, setVoiceHint] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the end when a message or "Thinking…" appears
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, busy, live.length > 0]);

  function send(text: string) {
    if (!text.trim() || busy) return;
    setDraft('');
    setError(null);
    void chatSession.send(api, text);
  }

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2>Ask {OWL_NAME}</h2>
        {messages.length > 0 && (
          <button
            type="button"
            className="wl-secondary"
            onClick={() => {
              chatSession.clear();
              setError(null);
            }}
            title="Clear this conversation and start again (I forget it too)"
          >
            New chat
          </button>
        )}
      </div>
      <p style={{ marginTop: 0, color: 'var(--wl-c-muted)' }}>
        AI running on this computer. It can check your balance, label payments, prepare reports and schedule payments.
        It never pays without your confirmation.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }} data-testid="chat-log">
        {messages.length === 0 && <p style={{ color: 'var(--wl-c-muted)', fontStyle: 'italic' }}>Try one of these:</p>}
        {messages.map((m) => (
          <div key={m.id} style={bubble(m.role)}>
            {m.role === 'assistant' ? <Markdown text={m.text} /> : <div>{m.text}</div>}
            {m.reply && <ReplyExtras api={api} reply={m.reply} restored={m.restored ?? false} />}
          </div>
        ))}
        {busy &&
          (live ? (
            <div style={bubble('assistant')} aria-live="polite" data-testid="chat-live">
              <Markdown text={live} />
              <span className="wl-caret" aria-hidden="true" />
            </div>
          ) : (
            <div style={{ ...bubble('assistant'), color: 'var(--wl-c-muted)' }}>Thinking…</div>
          ))}
        <div ref={endRef} />
      </div>
      {error ? <ErrorBox error={error} /> : null}
      {/* Ideas to start with; once the conversation runs they would only push the input down. */}
      {messages.length === 0 && (
        <div className="wl-chips" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {CHAT_SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="wl-chat-input"
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <MicButton
          api={api}
          disabled={busy}
          onError={setError}
          onText={(text) => {
            setError(null);
            setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text).slice(0, 2000));
            setVoiceHint(true);
            inputRef.current?.focus();
          }}
        />
        <input
          ref={inputRef}
          aria-label="Message to Wise"
          value={draft}
          maxLength={2000}
          placeholder="Type a request, e.g. What is my TUSDT balance?"
          onChange={(e) => {
            setDraft(e.target.value);
            if (!e.target.value) setVoiceHint(false);
          }}
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
      {voiceHint && draft && (
        <p style={{ margin: '6px 0 0', color: 'var(--wl-c-muted)', fontSize: '0.9em' }} role="status">
          We wrote down what you said. Check the text, fix it if needed, then press Send.
        </p>
      )}
    </section>
  );
}

type MicState = { s: 'idle' } | { s: 'recording'; since: number } | { s: 'transcribing' };

/** Click to start, click to stop. The transcript goes into the text box; nothing is sent automatically. */
function MicButton({
  api,
  disabled,
  onText,
  onError,
}: {
  api: ApiClient;
  disabled: boolean;
  onText: (text: string) => void;
  onError: (err: unknown) => void;
}) {
  const [st, setSt] = useState<MicState>({ s: 'idle' });
  const [now, setNow] = useState(Date.now());
  const recRef = useRef<VoiceRecording | null>(null);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => () => recRef.current?.cancel(), []);
  useEffect(() => {
    if (st.s !== 'recording') return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [st.s]);

  if (!canRecordVoice()) return null;

  async function start() {
    onError(null);
    try {
      recRef.current = await startRecording(() => stopRef.current());
      setNow(Date.now());
      setSt({ s: 'recording', since: Date.now() });
    } catch (err) {
      onError(micErrorText(err));
    }
  }

  async function stop() {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return;
    setSt({ s: 'transcribing' });
    try {
      const wav = await rec.stop();
      const { text } = await api.transcribe(wav);
      if (text.trim()) onText(text.trim());
      else
        onError('We could not make out any words. Try again a little closer to the microphone, or type your request.');
    } catch (err) {
      onError(errorText(err, 'We could not turn your voice into text. Try again, or type your request.'));
    } finally {
      setSt({ s: 'idle' });
    }
  }
  stopRef.current = () => void stop();

  const recording = st.s === 'recording';
  const secs = recording ? Math.min(VOICE_MAX_SECONDS, Math.floor((now - st.since) / 1000)) : 0;
  return (
    <button
      type="button"
      aria-pressed={recording}
      aria-label={recording ? 'Stop recording and write down what I said' : 'Speak your request'}
      title={`Speak your request (up to ${VOICE_MAX_SECONDS} seconds). The AI on this computer writes it down; you check it before sending.`}
      disabled={st.s === 'transcribing' || (disabled && !recording)}
      onClick={() => void (recording ? stop() : start())}
      style={
        recording
          ? { background: 'var(--wl-c-error)', color: 'var(--wl-c-surface)', borderColor: 'var(--wl-c-error)' }
          : undefined
      }
    >
      {st.s === 'transcribing' ? 'Listening…' : recording ? `● Stop (${secs}s)` : 'Speak'}
    </button>
  );
}

function ReplyExtras({ api, reply, restored }: { api: ApiClient; reply: ChatResponse; restored: boolean }) {
  return (
    <>
      {reply.toolCalls.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
          {reply.toolCalls.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tool calls have no ID and never reorder
            <ToolChip key={i} api={api} call={c} />
          ))}
        </div>
      )}
      {/* Payment requests made in this reply: read from the server by ID (live status, still there after a reload). */}
      {reply.toolCalls.flatMap((c, i) => {
        const id = c.name === 'create_receive_invoice' && c.ok ? receiveIdOf(c.result) : undefined;
        return id ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool calls have no ID and never reorder
          <div key={`rcv-${i}`} style={{ marginTop: 8 }}>
            <ReceiveCard api={api} receiveId={id} variant="chat" />
          </div>
        ) : (
          []
        );
      })}
      {reply.needsConfirmation &&
        (restored ? (
          <p style={{ fontSize: '0.9em', color: 'var(--wl-c-muted)', margin: '6px 0 0' }}>
            This confirmation was from an earlier visit. Ask again to prepare it now.
          </p>
        ) : (
          <ConfirmCard api={api} nc={reply.needsConfirmation} calls={reply.toolCalls} />
        ))}
    </>
  );
}

function ToolChip({ api, call }: { api: ApiClient; call: ToolCall }) {
  const toast = useToast();
  const fiscal = fiscalFromToolCall(call);
  const url = fiscal ? api.fiscalUrl(fiscal) : null;
  const link = toolLink(call);
  return (
    <span
      title={`Tool: ${call.name}${call.error ? `. ${call.error}` : ''}`}
      style={{
        fontSize: '0.8em',
        borderRadius: 10,
        padding: '0 8px',
        background: call.ok ? 'var(--wl-c-ok-bg)' : 'var(--wl-c-error-bg)',
        color: call.ok ? 'var(--wl-c-ok-text)' : 'var(--wl-c-error)',
      }}
    >
      {toolChipText(call)}
      {link && (
        <>
          {' '}
          <a href={link.href}>{link.label}</a>
        </>
      )}
      {fiscal &&
        (url ? (
          <>
            {' '}
            <a href={url} download={fiscalFilename(fiscal)}>
              Download
            </a>
          </>
        ) : (
          <>
            {' '}
            <button
              type="button"
              style={{ fontSize: '1em' }}
              onClick={() => toast('Report ready (demo mode)', 'success')}
            >
              Download
            </button>
          </>
        ))}
    </span>
  );
}

type CardState =
  | { s: 'open' }
  | { s: 'busy' }
  | { s: 'done'; text: string }
  | { s: 'cancelled' }
  | { s: 'error'; text: string };

function ConfirmCard({ api, nc, calls }: { api: ApiClient; nc: NeedsConfirmation; calls: readonly ToolCall[] }) {
  const toast = useToast();
  const [st, setSt] = useState<CardState>({ s: 'open' });

  async function confirm() {
    setSt({ s: 'busy' });
    try {
      const text = await confirmScheduleFromChat(api, nc, calls);
      setSt({ s: 'done', text });
      toast(text, 'success');
    } catch (err) {
      setSt({
        s: 'error',
        text: errorText(err, 'I could not schedule the payment. Ask me again, or schedule it from the invoice page.'),
      });
    }
  }

  const invoiceLink = nc.invoiceId ? `#/invoice/${encodeURIComponent(nc.invoiceId)}` : '#/pay/invoices';
  return (
    <div
      data-testid="confirm-card"
      style={{
        border: '2px solid var(--wl-c-warn-line)',
        background: 'var(--wl-c-surface)',
        borderRadius: 6,
        padding: 12,
        marginTop: 8,
      }}
    >
      <strong>Please check and confirm</strong>
      <p style={{ margin: '6px 0' }}>{nc.sentence}</p>
      {nc.kind === 'payment' ? (
        <p style={{ margin: 0 }}>
          <a href={invoiceLink}>Open the invoice to confirm the payment</a>
        </p>
      ) : st.s === 'done' ? (
        <p style={{ margin: 0, color: 'var(--wl-c-ok-text)' }}>
          {st.text} <a href="#/pay/scheduled">See scheduled payments</a>
        </p>
      ) : st.s === 'cancelled' ? (
        <p style={{ margin: 0, color: 'var(--wl-c-muted)' }}>Cancelled. Nothing was scheduled.</p>
      ) : (
        <>
          {st.s === 'error' && <p style={{ color: 'var(--wl-c-error)', margin: '0 0 6px' }}>{st.text}</p>}
          <button type="button" onClick={() => void confirm()} disabled={st.s === 'busy'}>
            {st.s === 'busy' ? 'Scheduling…' : 'Confirm'}
          </button>{' '}
          <button
            className="wl-secondary"
            type="button"
            onClick={() => setSt({ s: 'cancelled' })}
            disabled={st.s === 'busy'}
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

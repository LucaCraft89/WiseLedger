import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from './api/client.js';
import type { ChatResponse } from './api/contracts.js';
import {
  CHAT_SUGGESTIONS,
  type ChatTurn,
  chatHistory,
  confirmScheduleFromChat,
  fiscalFilename,
  fiscalFromToolCall,
  type NeedsConfirmation,
  type ToolCall,
  toolChipText,
} from './lib/ledger.js';
import { canRecordVoice, micErrorText, startRecording, VOICE_MAX_SECONDS, type VoiceRecording } from './lib/voice.js';
import { Markdown } from './Markdown.js';
import { ErrorBox, errorText, useToast } from './ui.js';

interface Message extends ChatTurn {
  id: number;
  reply?: ChatResponse;
}

const bubble = (role: ChatTurn['role']) =>
  ({
    alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
    background: role === 'user' ? '#e7f1ff' : '#f1f3f5',
    borderRadius: 8,
    padding: '8px 12px',
    maxWidth: '85%',
    whiteSpace: role === 'user' ? 'pre-wrap' : 'normal',
  }) as const;

let nextMsgId = 0;

/** #/chat: ask the Treasurer (local AI with wallet tools). Spending always needs a confirmation card. */
export function ChatPage({ api }: { api: ApiClient }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [voiceHint, setVoiceHint] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the end when a message or "Thinking…" appears
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    const history = chatHistory(messages);
    setMessages((m) => [...m, { id: ++nextMsgId, role: 'user', text: message }]);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const reply = await api.chat({ message: message.slice(0, 2000), history });
      setMessages((m) => [...m, { id: ++nextMsgId, role: 'assistant', text: reply.text, reply }]);
    } catch (err) {
      setError(errorText(err, 'The Treasurer did not answer. Try again in a minute.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Ask the Treasurer</h2>
      <p style={{ marginTop: 0, color: '#555' }}>
        AI running on this computer. It can check your balance, label payments, prepare reports and schedule payments.
        It never pays without your confirmation.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }} data-testid="chat-log">
        {messages.length === 0 && <p style={{ color: '#555', fontStyle: 'italic' }}>Try one of these:</p>}
        {messages.map((m) => (
          <div key={m.id} style={bubble(m.role)}>
            {m.role === 'assistant' ? <Markdown text={m.text} /> : <div>{m.text}</div>}
            {m.reply && <ReplyExtras api={api} reply={m.reply} />}
          </div>
        ))}
        {busy && <div style={{ ...bubble('assistant'), color: '#555' }}>Thinking…</div>}
        <div ref={endRef} />
      </div>
      {error ? <ErrorBox error={error} /> : null}
      <div className="wl-chips" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {CHAT_SUGGESTIONS.map((s) => (
          <button key={s} type="button" disabled={busy} onClick={() => void send(s)}>
            {s}
          </button>
        ))}
      </div>
      <form
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
          aria-label="Message to the Treasurer"
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
        <p style={{ margin: '6px 0 0', color: '#555', fontSize: '0.9em' }} role="status">
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
      style={recording ? { background: '#b00020', color: '#fff', borderColor: '#b00020' } : undefined}
    >
      {st.s === 'transcribing' ? 'Listening…' : recording ? `● Stop (${secs}s)` : 'Speak'}
    </button>
  );
}

function ReplyExtras({ api, reply }: { api: ApiClient; reply: ChatResponse }) {
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
      {reply.needsConfirmation && <ConfirmCard api={api} nc={reply.needsConfirmation} calls={reply.toolCalls} />}
    </>
  );
}

function ToolChip({ api, call }: { api: ApiClient; call: ToolCall }) {
  const toast = useToast();
  const fiscal = fiscalFromToolCall(call);
  const url = fiscal ? api.fiscalUrl(fiscal) : null;
  return (
    <span
      title={`Tool: ${call.name}${call.error ? `. ${call.error}` : ''}`}
      style={{
        fontSize: '0.8em',
        borderRadius: 10,
        padding: '0 8px',
        background: call.ok ? '#d4edda' : '#f8d7da',
        color: call.ok ? '#155724' : '#b00020',
      }}
    >
      {toolChipText(call)}
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
      setSt({ s: 'error', text: errorText(err, 'Could not schedule the payment.') });
    }
  }

  const invoiceLink = nc.invoiceId ? `#/invoice/${encodeURIComponent(nc.invoiceId)}` : '#/invoices';
  return (
    <div
      data-testid="confirm-card"
      style={{ border: '2px solid #f0ad4e', background: '#fff', borderRadius: 6, padding: 12, marginTop: 8 }}
    >
      <strong>Please check and confirm</strong>
      <p style={{ margin: '6px 0' }}>{nc.sentence}</p>
      {nc.kind === 'payment' ? (
        <p style={{ margin: 0 }}>
          <a href={invoiceLink}>Open the invoice to confirm the payment</a>
        </p>
      ) : st.s === 'done' ? (
        <p style={{ margin: 0, color: '#155724' }}>
          {st.text} <a href="#/schedule">See scheduled payments</a>
        </p>
      ) : st.s === 'cancelled' ? (
        <p style={{ margin: 0, color: '#555' }}>Cancelled. Nothing was scheduled.</p>
      ) : (
        <>
          {st.s === 'error' && <p style={{ color: '#b00020', margin: '0 0 6px' }}>{st.text}</p>}
          <button type="button" onClick={() => void confirm()} disabled={st.s === 'busy'}>
            {st.s === 'busy' ? 'Scheduling…' : 'Confirm'}
          </button>{' '}
          <button type="button" onClick={() => setSt({ s: 'cancelled' })} disabled={st.s === 'busy'}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

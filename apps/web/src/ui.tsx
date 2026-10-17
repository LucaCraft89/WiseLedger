import QRCode from 'qrcode';
import { Component, createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiCallError } from './api/client.js';
import { apiErrorWords } from './lib/payment.js';

type ToastKind = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}
type ShowToast = (text: string, kind?: ToastKind) => void;

const ToastContext = createContext<ShowToast>(() => {});

/** Show a short message in the bottom corner: `const toast = useToast(); toast('Copied', 'success')`. */
export const useToast = (): ShowToast => useContext(ToastContext);

/** Error → message for a toast (ApiCallError messages are already plain language). */
export const errorText = (err: unknown, fallback = 'Something went wrong. Please try again.'): string => {
  if (err instanceof ApiCallError) return apiErrorWords(err.code, err.message, err.status);
  return err instanceof Error && err.message ? err.message : fallback;
};

const TOAST_COLORS: Record<ToastKind, string> = {
  info: 'var(--wl-c-neutral-bg)',
  success: 'var(--wl-c-ok-bg)',
  error: 'var(--wl-c-error-bg)',
};

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback<ShowToast>(
    (text, kind = 'info') => {
      const id = ++nextId;
      setItems((xs) => [...xs.slice(-3), { id, kind, text }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 3500);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          left: 16,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            style={{
              background: TOAST_COLORS[t.kind],
              padding: '8px 12px',
              borderRadius: 6,
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              maxWidth: 420,
              pointerEvents: 'auto',
              display: 'flex',
              gap: 12,
              alignItems: 'baseline',
            }}
          >
            <span>{t.text}</span>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Close message">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Top-level safety net: a crash in one page shows a plain message instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error('WiseLedger page error', error);
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h2>Something went wrong on this page.</h2>
        <p>Reload to try again. Your invoices and your wallet are safe: nothing is paid without your OK.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>{' '}
        <button
          type="button"
          onClick={() => {
            window.location.hash = '#/';
            this.setState({ failed: false });
          }}
        >
          Go to the start page
        </button>
      </div>
    );
  }
}

/** Button that copies `value` and confirms with a toast. */
export function CopyButton({ value, label = 'Copy', what = 'Text' }: { value: string; label?: string; what?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        if (!navigator.clipboard) {
          toast('Copying is not available here. Select the text and copy it by hand.', 'error');
          return;
        }
        navigator.clipboard.writeText(value).then(
          () => toast(`${what} copied`, 'success'),
          () => toast('Could not copy. Select the text and copy it by hand.', 'error'),
        );
      }}
    >
      {label}
    </button>
  );
}

/** QR code for `value`, rendered locally (no network) as a data URL. */
export function Qr({ value, size = 200, alt }: { value: string; size?: number; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: 'M' }).then(
      (url) => live && setSrc(url),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [value, size]);
  if (!src) return <div style={{ width: size, height: size, background: 'var(--wl-c-bubble)' }} />;
  return <img src={src} width={size} height={size} alt={alt} style={{ imageRendering: 'pixelated' }} />;
}

/** Small "loading" line used by every list. */
export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <p role="status" style={{ color: 'var(--wl-c-muted)' }}>
      {text}
    </p>
  );
}

/** Plain empty state for a list. */
export function Empty({ text }: { text: string }) {
  return <p style={{ color: 'var(--wl-c-muted)', fontStyle: 'italic' }}>{text}</p>;
}

/** Error message in plain words with an optional "Try again" button. */
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div
      role="alert"
      style={{ background: 'var(--wl-c-error-bg)', padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}
    >
      <span>{typeof error === 'string' ? error : errorText(error)}</span>{' '}
      {retry && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

/** Loads data on mount and on `reload()`, tracking loading and error. `load` must be stable (useCallback). */
export function useLoad<T>(load: () => Promise<T>): {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    void tick;
    let live = true;
    setLoading(true);
    setError(null);
    load().then(
      (d) => {
        if (!live) return;
        setData(d);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [load, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

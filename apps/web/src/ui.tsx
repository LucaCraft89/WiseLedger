import QRCode from 'qrcode';
import { Component, createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

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
export const errorText = (err: unknown, fallback = 'Something went wrong. Please try again.'): string =>
  err instanceof Error && err.message ? err.message : fallback;

const TOAST_COLORS: Record<ToastKind, string> = { info: '#e2e3e5', success: '#d4edda', error: '#f8d7da' };

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
  if (!src) return <div style={{ width: size, height: size, background: '#f1f3f5' }} />;
  return <img src={src} width={size} height={size} alt={alt} style={{ imageRendering: 'pixelated' }} />;
}

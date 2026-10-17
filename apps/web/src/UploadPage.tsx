import { type FormEvent, useState } from 'react';
import type { ApiClient } from './api/client.js';

export function UploadPage({ api, onCreated }: { api: ApiClient; onCreated: (invoiceId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file && !text.trim()) {
      setError('Choose an invoice file or paste the invoice text first.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.createInvoice(file ? { file } : { text });
      onCreated(res.invoiceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>Check an invoice before paying it</h2>
      <p>Upload the invoice you received. We read it on this computer, check it for fraud and explain what we found.</p>

      {/* One big drop area: drag the invoice here, or click to choose it. */}
      <label
        className={`wl-dropzone${over ? ' wl-dropzone-over' : ''}${file ? ' wl-dropzone-ready' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) setFile(dropped);
        }}
      >
        <span style={{ fontSize: '1.15em', fontWeight: 600 }}>
          {file ? `Ready: ${file.name}` : 'Drop the invoice here, or click to choose it'}
        </span>
        <span style={{ color: 'var(--wl-c-muted)' }}>
          {file ? 'Click to choose another file' : 'PDF, photo, text or FatturaPA XML'}
        </span>
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.xml"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="wl-visually-hidden"
        />
      </label>

      <details style={{ margin: '12px 0 16px' }}>
        <summary>No file? Paste the invoice text instead</summary>
        <textarea
          aria-label="Invoice text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          style={{ display: 'block', width: '100%', marginTop: 8 }}
          disabled={!!file}
          placeholder={file ? 'A file is selected; the file will be used.' : 'Paste the text of the invoice here'}
        />
      </details>

      {error && <p style={{ color: 'var(--wl-c-error)' }}>{error}</p>}
      <button type="submit" disabled={busy} style={{ fontSize: '1.1em', padding: '8px 20px' }}>
        {busy ? 'Uploading…' : 'Check this invoice'}
      </button>
    </form>
  );
}

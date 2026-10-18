import { type FormEvent, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { InvoiceTabs } from './InvoiceListPage.js';
import { OwlChip } from './ui.js';

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
      setError('Choose an invoice file or paste its text first, then press “Read this invoice”.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.createInvoice(file ? { file } : { text });
      onCreated(res.invoiceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'I could not take that invoice. Check the file and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>Pay an invoice</h2>
      <InvoiceTabs current="upload" />
      <p>
        <OwlChip mood={busy ? 'reading' : 'all_good'} /> Give me the invoice. I read it on this computer and check it
        before you pay.
      </p>

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
        {busy ? 'Reading your invoice… (about 30 seconds on this computer)' : 'Read this invoice'}
      </button>
    </form>
  );
}

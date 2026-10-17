import { type FormEvent, useState } from 'react';
import type { ApiClient } from './api/client.js';

export function UploadPage({ api, onCreated }: { api: ApiClient; onCreated: (invoiceId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      <label style={{ display: 'block', margin: '16px 0' }}>
        <strong>1. Choose the invoice file</strong> (PDF, image, text or XML)
        <br />
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.xml"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <label style={{ display: 'block', margin: '16px 0' }}>
        <strong>…or paste the invoice text</strong>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          style={{ display: 'block', width: '100%' }}
          disabled={!!file}
          placeholder={file ? 'A file is selected; the file will be used.' : 'Paste the text of the invoice here'}
        />
      </label>

      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      <button type="submit" disabled={busy} style={{ fontSize: '1.1em', padding: '8px 20px' }}>
        {busy ? 'Uploading…' : '2. Check this invoice'}
      </button>
    </form>
  );
}

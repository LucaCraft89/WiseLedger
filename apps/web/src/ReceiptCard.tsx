import { useCallback } from 'react';
import type { ApiClient } from './api/client.js';
import { receiptPdf, receiptView } from './lib/receipt.js';
import { Slip, Stamp } from './Stamp.js';
import { ErrorBox, errorText, Loading, useLoad, useToast } from './ui.js';

/** A paper receipt for one settled transfer (from the server), with the PDF made right here in the browser. */
export function ReceiptCard({ api, transferId }: { api: ApiClient; transferId: string }) {
  const toast = useToast();
  const load = useCallback(async () => receiptView(await api.receipt(transferId)), [api, transferId]);
  const { data, error, loading, reload } = useLoad(load);

  if (error)
    return <ErrorBox error={errorText(error, 'I could not make the receipt. Try again in a moment.')} retry={reload} />;
  if (loading && !data) return <Loading text="Making your receipt…" />;
  if (!data)
    return (
      <p style={{ color: 'var(--wl-c-muted)' }}>
        There is no receipt for this line: no money has moved here yet, or I made the tokens myself.
      </p>
    );

  async function download() {
    if (!data) return;
    try {
      const bytes = await receiptPdf(data);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = data.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toast('I could not make the PDF. Try again.', 'error');
    }
  }

  return (
    <div data-testid="receipt-card">
      <Slip title={data.title} stamp={<Stamp kind={data.stamp} />} rows={data.rows} amount={data.amount}>
        <p className="wl-slip-how">
          <strong>How this was settled.</strong> {data.how}
        </p>
        <p className="wl-slip-sign">{data.signed}</p>
      </Slip>
      <button type="button" className="wl-secondary" onClick={() => void download()}>
        Download receipt (PDF)
      </button>
    </div>
  );
}

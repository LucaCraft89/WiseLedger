// Decodes an on-chain RGB invoice with rgb-lib's own parser (Invoice), without opening a wallet or going online.
// Same mapping as WdkRgbWallet.decodeInvoice. Used where no wallet is running (evals, fixture checks).
import { createRequire } from 'node:module';
import { type DecodedInvoice, InvalidInvoice } from 'core';

interface RgbLibInvoice {
  invoiceData(): {
    recipientId: string;
    assetId?: string | null;
    assignment?: Record<string, unknown>;
    network: unknown;
    expirationTimestamp?: number | null;
    transportEndpoints?: string[];
  };
  drop(): void;
}

/** rgb-lib assignment → base units ("Any" or 0 = open amount). */
export function assignmentAmount(a: Record<string, unknown> | undefined): string | undefined {
  if (!a) return undefined;
  const v = a.Fungible ?? a.fungible ?? (a.type === 'Fungible' ? a.value : undefined);
  return typeof v === 'number' && v > 0 ? String(v) : undefined;
}

/** rgb-lib invoice data → the contract's DecodedInvoice. */
export function toDecodedInvoice(rgbInvoice: string, d: ReturnType<RgbLibInvoice['invoiceData']>): DecodedInvoice {
  const amount = assignmentAmount(d.assignment);
  return {
    rgbInvoice,
    recipientId: d.recipientId,
    ...(d.assetId ? { assetId: d.assetId } : {}),
    ...(amount ? { amount } : {}),
    network: String(d.network),
    ...(d.expirationTimestamp ? { expiresAt: new Date(d.expirationTimestamp * 1000).toISOString() } : {}),
    transportEndpoints: d.transportEndpoints ?? [],
  };
}

/** Throws InvalidInvoice. Loads the native rgb-lib binding on first use. */
export function decodeRgbInvoiceOffline(rgbInvoice: string): DecodedInvoice {
  const rgblib = createRequire(import.meta.url)('@utexo/rgb-lib') as {
    Invoice: new (s: string) => RgbLibInvoice;
  };
  let inv: RgbLibInvoice;
  try {
    inv = new rgblib.Invoice(rgbInvoice);
  } catch {
    throw new InvalidInvoice();
  }
  try {
    return toDecodedInvoice(rgbInvoice, inv.invoiceData());
  } finally {
    inv.drop();
  }
}

/** rpcs://host/path → https://host/path (rgb-lib's JSON-RPC proxy scheme). */
export function proxyUrl(endpoint: string): string | undefined {
  const m = /^(rpcs?):\/\/(.+)$/i.exec(endpoint.trim());
  if (!m) return /^https?:\/\//i.test(endpoint) ? endpoint : undefined;
  return `${m[1]?.toLowerCase() === 'rpcs' ? 'https' : 'http'}://${m[2]}`;
}

/**
 * Asks the request's RGB proxy whether a payment (consignment) was already posted for this recipient ID: a payment
 * request can be paid once, and paying it again fails at send time with RecipientIDAlreadyUsed. true / false when a
 * proxy answered, undefined when none did (never blocks a payment on a network hiccup).
 */
export async function requestAlreadyPaid(
  recipientId: string,
  endpoints: readonly string[],
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean | undefined> {
  const f = opts.fetch ?? fetch;
  for (const e of endpoints) {
    const url = proxyUrl(e);
    if (!url) continue;
    try {
      const res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'consignment.get',
          params: { recipient_id: recipientId },
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      const body = (await res.json()) as { result?: { consignment?: unknown } | null; error?: unknown };
      if (body.result && typeof body.result.consignment === 'string' && body.result.consignment) return true;
      if (body.error || body.result === null || body.result) return false;
    } catch {
      // try the next endpoint
    }
  }
  return undefined;
}

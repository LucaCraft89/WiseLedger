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

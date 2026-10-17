import {
  type AppEvent,
  AppEvent as AppEventSchema,
  type ConfirmRequest,
  type ConfirmResponse,
  type CreateInvoiceResponse,
  type HealthResponse,
  type InvoiceDetailResponse,
  type InvoiceListResponse,
  type RejectResponse,
  SSE_EVENT_NAME,
} from './contracts.js';

export type InvoiceInput = { file: File } | { text: string; filename?: string };

/** What the screens need from the backend. Implemented by the HTTP client and the in-browser fake. */
export interface ApiClient {
  readonly mode: 'server' | 'fake';
  health(): Promise<HealthResponse>;
  createInvoice(input: InvoiceInput): Promise<CreateInvoiceResponse>;
  /** All invoices, newest first. */
  listInvoices(): Promise<InvoiceListResponse>;
  getInvoice(id: string): Promise<InvoiceDetailResponse>;
  /** Live events for one invoice. Returns an unsubscribe function. */
  subscribe(id: string, onEvent: (e: AppEvent) => void): () => void;
  confirm(id: string, req: ConfirmRequest): Promise<ConfirmResponse>;
  reject(id: string, reason?: string): Promise<RejectResponse>;
}

/** Error with a plain-language message (from the server's ApiError body when present). */
export class ApiCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiCallError('NETWORK', 'Cannot reach the WiseLedger server. Is it running?');
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiCallError(err?.code ?? `HTTP_${res.status}`, err?.message ?? `The server answered ${res.status}.`);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function createHttpClient(base = ''): ApiClient {
  return {
    mode: 'server',
    health: () => call(`${base}/api/health`),
    createInvoice(input) {
      if ('file' in input) {
        const form = new FormData();
        form.append('file', input.file, input.file.name);
        return call(`${base}/api/invoices`, { method: 'POST', body: form });
      }
      return call(`${base}/api/invoices`, json({ text: input.text, filename: input.filename }));
    },
    listInvoices: () => call(`${base}/api/invoices`),
    getInvoice: (id) => call(`${base}/api/invoices/${encodeURIComponent(id)}`),
    subscribe(id, onEvent) {
      const es = new EventSource(`${base}/api/invoices/${encodeURIComponent(id)}/events`);
      es.addEventListener(SSE_EVENT_NAME, (msg) => {
        const parsed = AppEventSchema.safeParse(JSON.parse((msg as MessageEvent<string>).data));
        if (parsed.success) onEvent(parsed.data);
      });
      return () => es.close();
    },
    confirm: (id, req) => call(`${base}/api/invoices/${encodeURIComponent(id)}/confirm`, json(req)),
    reject: (id, reason) => call(`${base}/api/invoices/${encodeURIComponent(id)}/reject`, json({ reason })),
  };
}

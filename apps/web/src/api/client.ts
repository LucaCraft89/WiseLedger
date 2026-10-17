import { fiscalUrl } from '../lib/ledger.js';
import {
  type AppEvent,
  AppEvent as AppEventSchema,
  type ChatRequest,
  type ChatResponse,
  type ConfirmRequest,
  type ConfirmResponse,
  type CreateInvoiceResponse,
  type FiscalQuery,
  type HealthResponse,
  type InvoiceDetailResponse,
  type InvoiceListResponse,
  type LabelsPutRequest,
  type LabelsPutResponse,
  type OnboardingCreateRequest,
  type OnboardingCreateResponse,
  type OnboardingOkResponse,
  type OnboardingRestoreRequest,
  type OnboardingRestoreResponse,
  type OnboardingStatusResponse,
  type OnboardingUnlockRequest,
  type RejectResponse,
  type ScheduleCancelResponse,
  type ScheduleListResponse,
  SSE_EVENT_NAME,
  type TransfersResponse,
  type WalletReceiveRequest,
  type WalletReceiveResponse,
  type WalletResponse,
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
  /** Wallet backend, network and assets (ticker and precision for amounts). */
  wallet(): Promise<WalletResponse>;
  /** New RGB receive invoice (optional asset and amount in base units). */
  receive(req: WalletReceiveRequest): Promise<WalletReceiveResponse>;
  /** Wallet transfers with their labels. */
  transfers(): Promise<TransfersResponse>;
  /** Replace the labels of one transfer. */
  setLabels(transferId: string, req: LabelsPutRequest): Promise<LabelsPutResponse>;
  /** Talk to the Treasurer (local AI with wallet tools). */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Scheduled payments. */
  schedule(): Promise<ScheduleListResponse>;
  cancelJob(jobId: string): Promise<ScheduleCancelResponse>;
  /** Download URL of the fiscal report, or null in demo mode (no file to download). */
  fiscalUrl(q: FiscalQuery): string | null;
  /** First-run state. An older server without the route (404) counts as `ready`. */
  onboarding(): Promise<OnboardingStatusResponse>;
  /** New wallet: the recovery words come back ONCE. Never store them. */
  onboardingCreate(req: OnboardingCreateRequest): Promise<OnboardingCreateResponse>;
  /** The user confirmed they wrote the words down. */
  onboardingSeedConfirmed(): Promise<OnboardingOkResponse>;
  onboardingRestore(req: OnboardingRestoreRequest): Promise<OnboardingRestoreResponse>;
  onboardingUnlock(req: OnboardingUnlockRequest): Promise<OnboardingOkResponse>;
}

/** Answer used when the server has no onboarding route (older server): the wallet is simply ready. */
export const READY_ONBOARDING: OnboardingStatusResponse = {
  state: 'ready',
  seedShown: true,
  network: 'mock',
  walletBackend: 'unknown',
  minPassphrase: 0,
};

/** Error with a plain-language message (from the server's ApiError body when present). */
export class ApiCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** HTTP status when the server answered (undefined for network errors and the fake). */
    readonly status?: number,
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
    throw new ApiCallError(
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `The server answered ${res.status}.`,
      res.status,
    );
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
    wallet: () => call(`${base}/api/wallet`),
    receive: (req) => call(`${base}/api/wallet/receive`, json(req)),
    transfers: () => call(`${base}/api/transfers`),
    setLabels: (transferId, req) =>
      call(`${base}/api/labels/${encodeURIComponent(transferId)}`, { ...json(req), method: 'PUT' }),
    chat: (req) => call(`${base}/api/agent/chat`, json(req)),
    schedule: () => call(`${base}/api/schedule`),
    cancelJob: (jobId) => call(`${base}/api/schedule/${encodeURIComponent(jobId)}/cancel`, json({})),
    fiscalUrl: (q) => fiscalUrl(q, base),
    async onboarding() {
      try {
        return await call<OnboardingStatusResponse>(`${base}/api/onboarding`);
      } catch (err) {
        if (err instanceof ApiCallError && err.status === 404) return READY_ONBOARDING;
        throw err;
      }
    },
    onboardingCreate: (req) => call(`${base}/api/onboarding/create`, json(req)),
    onboardingSeedConfirmed: () => call(`${base}/api/onboarding/seed-confirmed`, json({ confirmed: true })),
    onboardingRestore: (req) => call(`${base}/api/onboarding/restore`, json(req)),
    onboardingUnlock: (req) => call(`${base}/api/onboarding/unlock`, json(req)),
  };
}

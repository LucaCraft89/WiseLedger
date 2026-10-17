import { fiscalUrl } from '../lib/ledger.js';
import {
  type AppEvent,
  AppEvent as AppEventSchema,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamHooks,
  ChatStreamLine,
  type ConfirmRequest,
  type ConfirmResponse,
  type CreateInvoiceResponse,
  type FiscalQuery,
  type HealthResponse,
  type InvoiceDetailResponse,
  type InvoiceListResponse,
  type LabelsPutRequest,
  type LabelsPutResponse,
  type LightningStatusResponse,
  type OnboardingCreateRequest,
  type OnboardingCreateResponse,
  type OnboardingOkResponse,
  type OnboardingRestoreRequest,
  type OnboardingRestoreResponse,
  type OnboardingStatusResponse,
  type OnboardingUnlockRequest,
  type ReceivesListResponse,
  type RejectResponse,
  type ScheduleCancelResponse,
  type ScheduleListResponse,
  SSE_EVENT_NAME,
  type TranscribeResponse,
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
  /** Payment requests handed out, newest first, with the status of the payment that answers each. */
  receives(): Promise<ReceivesListResponse>;
  /** Lightning node and channels. A server without the route (404) counts as Lightning off. */
  lightning(): Promise<LightningStatusResponse>;
  /** Wallet transfers with their labels. */
  transfers(): Promise<TransfersResponse>;
  /** Replace the labels of one transfer. */
  setLabels(transferId: string, req: LabelsPutRequest): Promise<LabelsPutResponse>;
  /** Talk to the Treasurer (local AI with wallet tools). */
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** The same, with the reply text as the model writes it (onReset: a new model turn starts, drop the live text). */
  chatStream(req: ChatRequest, hooks: ChatStreamHooks): Promise<ChatResponse>;
  /** Speech to text on this computer (QVAC Parakeet). Audio: 16 kHz mono WAV. The text only fills the chat box. */
  transcribe(audio: Blob): Promise<TranscribeResponse>;
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
/** What a server without Lightning (or without the route) means. */
export const LIGHTNING_OFF: LightningStatusResponse = { enabled: false, channels: [] };

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

/** Reads NDJSON ChatStreamLine lines until the reply (or an error line). */
export async function readChatStream(body: ReadableStream<Uint8Array>, hooks: ChatStreamHooks): Promise<ChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handle = (raw: string): ChatResponse | undefined => {
    if (!raw.trim()) return undefined;
    const parsed = ChatStreamLine.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const l = parsed.data;
    if (l.t === 'token') hooks.onToken(l.text);
    else if (l.t === 'reset') hooks.onReset?.();
    else if (l.t === 'error') throw new ApiCallError(l.code, l.message);
    else return l.reply;
    return undefined;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const reply = handle(buf.slice(0, nl));
      if (reply) return reply;
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
    if (done) {
      const reply = handle(buf);
      if (reply) return reply;
      throw new ApiCallError('NO_REPLY', 'The Treasurer stopped without an answer. Try again in a minute.');
    }
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiCallError(
      'NETWORK',
      'We could not reach WiseLedger on this computer. Check that it is running, then try again.',
    );
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiCallError(
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `Something went wrong inside WiseLedger (error ${res.status}). Try again in a minute.`,
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
    receives: () => call(`${base}/api/wallet/receives`),
    async lightning() {
      try {
        return await call<LightningStatusResponse>(`${base}/api/wallet/lightning`);
      } catch (err) {
        if (err instanceof ApiCallError && err.status === 404) return LIGHTNING_OFF;
        throw err;
      }
    },
    transfers: () => call(`${base}/api/transfers`),
    setLabels: (transferId, req) =>
      call(`${base}/api/labels/${encodeURIComponent(transferId)}`, { ...json(req), method: 'PUT' }),
    chat: (req) => call(`${base}/api/agent/chat`, json(req)),
    async chatStream(req, hooks) {
      let res: Response;
      try {
        res = await fetch(`${base}/api/agent/chat/stream`, json(req));
      } catch {
        throw new ApiCallError(
          'NETWORK',
          'We could not reach WiseLedger on this computer. Check that it is running, then try again.',
        );
      }
      // An older server without the stream route: the plain JSON chat still works.
      if (res.status === 404) return call(`${base}/api/agent/chat`, json(req));
      if (!res.ok || !res.body) {
        const err = ((await res.json().catch(() => undefined)) as { error?: { code?: string; message?: string } })
          ?.error;
        throw new ApiCallError(
          err?.code ?? `HTTP_${res.status}`,
          err?.message ?? 'The Treasurer did not answer. Try again in a minute.',
          res.status,
        );
      }
      return readChatStream(res.body, hooks);
    },
    async transcribe(audio) {
      try {
        return await call<TranscribeResponse>(`${base}/api/agent/transcribe`, {
          method: 'POST',
          headers: { 'content-type': audio.type || 'audio/wav' },
          body: audio,
        });
      } catch (err) {
        if (err instanceof ApiCallError && err.status === 404) {
          throw new ApiCallError(
            'VOICE_UNAVAILABLE',
            'Voice input is not available on this WiseLedger yet. Please type your request.',
            404,
          );
        }
        throw err;
      }
    },
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

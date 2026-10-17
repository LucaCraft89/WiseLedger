// Owner: B. Server-sent events (one union for invoice timelines, agent activity and transfers).
import { z } from 'zod';
import { AnalysisReport, IsoDateTime, RiskFlag } from './analysis.js';
import type { InvoiceState } from './orchestrator.js';
import { TransferStatusSchema } from './wallet.js';

/** InvoiceState is owned by orchestrator.ts; validated as a non-empty string here. */
const InvoiceStateSchema = z.custom<InvoiceState>((v) => typeof v === 'string' && v.length > 0);

export const Stage = z.enum([
  'reading',
  'extracting',
  'checking',
  'summarizing',
  'analyzed',
  'planning',
  'executing',
  'done',
]);
export type Stage = z.infer<typeof Stage>;

export const AgentName = z.enum(['analyst', 'treasurer']);
export type AgentName = z.infer<typeof AgentName>;

const base = { invoiceId: z.string().optional(), at: IsoDateTime };

export const StageEvent = z.object({
  type: z.literal('stage'),
  ...base,
  stage: Stage,
  status: z.enum(['start', 'end', 'error']),
  message: z.string().optional(),
});
export const TokenEvent = z.object({ type: z.literal('token'), ...base, agent: AgentName, text: z.string() });
export const ToolCallEvent = z.object({
  type: z.literal('toolCall'),
  ...base,
  agent: AgentName,
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(['called', 'ok', 'rejected', 'error']),
  message: z.string().optional(),
});
export const FlagEvent = z.object({ type: z.literal('flag'), ...base, flag: RiskFlag });
export const ReportEvent = z.object({ type: z.literal('report'), ...base, report: AnalysisReport });
export const StateEvent = z.object({
  type: z.literal('state'),
  ...base,
  from: InvoiceStateSchema.optional(),
  to: InvoiceStateSchema,
});
export const TransferEvent = z.object({
  type: z.literal('transfer'),
  ...base,
  transferId: z.string(),
  status: TransferStatusSchema,
  txid: z.string().optional(),
});
/** Plain-language error for the UI (additive to the PLAN sketch). */
export const ErrorEvent = z.object({ type: z.literal('error'), ...base, code: z.string(), message: z.string() });

export const AppEvent = z.discriminatedUnion('type', [
  StageEvent,
  TokenEvent,
  ToolCallEvent,
  FlagEvent,
  ReportEvent,
  StateEvent,
  TransferEvent,
  ErrorEvent,
]);
export type AppEvent = z.infer<typeof AppEvent>;
export type AppEventType = AppEvent['type'];
export type StageEvent = z.infer<typeof StageEvent>;
export type TokenEvent = z.infer<typeof TokenEvent>;
export type ToolCallEvent = z.infer<typeof ToolCallEvent>;
export type FlagEvent = z.infer<typeof FlagEvent>;
export type ReportEvent = z.infer<typeof ReportEvent>;
export type StateEvent = z.infer<typeof StateEvent>;
export type TransferEvent = z.infer<typeof TransferEvent>;
export type ErrorEvent = z.infer<typeof ErrorEvent>;

/** SSE event name used on the wire (`event: app`), data = JSON AppEvent. */
export const SSE_EVENT_NAME = 'app';

// Owner: B. LLM provider port (QVAC / qvac serve --openai / mock) and the Treasurer agent port.
import type { ZodType } from 'zod';
import type { LlmProviderName } from './analysis.js';
import type { EmitFn } from './analysis.js';
import type { Confirmation, ExecutionResult, PaymentPlan } from './orchestrator.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** Mirrors the QVAC `history` entry; `attachments` are local file paths for the vision projector. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  attachments?: { path: string }[];
  /** For role 'tool': the call this message answers. */
  toolCallId?: string;
}

export interface JsonSchemaFormat {
  type: 'json_schema';
  json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
}

/** Tool as the model sees it. `parameters` is a JSON schema (providers convert as needed). */
export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 'required' forces some tool; a tool name forces that tool. */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

interface BaseRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  seed?: number;
  /** Caller-managed QVAC kvCache key for a fixed system prefix. */
  kvCacheKey?: string;
  signal?: AbortSignal;
}

/** Structured output and tools are never combined in one call (QVAC limitation). */
export type CompletionRequest =
  | (BaseRequest & { responseFormat: JsonSchemaFormat; tools?: never; toolChoice?: never })
  | (BaseRequest & { tools: LlmToolSpec[]; toolChoice?: ToolChoice; responseFormat?: never })
  | (BaseRequest & { responseFormat?: never; tools?: never; toolChoice?: never });

export function assertRequestShape(req: CompletionRequest): void {
  const r = req as BaseRequest & { responseFormat?: unknown; tools?: unknown };
  if (r.responseFormat && r.tools) throw new Error('responseFormat and tools cannot be combined in one call');
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  /** Parsed JSON when responseFormat was set and the text parsed; validation is the caller's job. */
  json?: unknown;
  toolCalls: ToolCall[];
  stopReason: 'eos' | 'length' | 'cancelled' | 'error' | 'tool';
  stats?: { promptTokens?: number; completionTokens?: number; tokensPerSecond?: number; ttftMs?: number; totalMs?: number };
}

export type LlmEvent =
  | { type: 'token'; text: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'done'; result: LlmResult };

export type LlmState = 'unloaded' | 'loading' | 'ready' | 'error';

export interface LlmInfo {
  provider: LlmProviderName;
  /** Model constant or name, e.g. QWEN3_5_2B_MULTIMODAL_Q4_K_M. */
  model: string;
  state: LlmState;
  /** True when inference runs on this device (qvac, or openai against localhost/LAN qvac serve). */
  onDevice: boolean;
  error?: string;
}

export interface LlmProvider {
  info(): LlmInfo;
  complete(req: CompletionRequest): Promise<LlmResult>;
  stream(req: CompletionRequest): AsyncIterable<LlmEvent>;
  warmUp?(): Promise<void>;
  unload?(): Promise<void>;
}

/** Treasurer tool. Arguments are short IDs, enums and numbers; handlers resolve full objects from the store. */
export interface ToolDef<A = unknown> {
  name: string;
  description: string;
  params: ZodType<A>;
  /** Spend-type tools return a NeedsConfirmation instead of executing when no confirmation exists. */
  requiresConfirmation: boolean;
  handler(args: A): Promise<unknown>;
}

export interface NeedsConfirmation {
  needsConfirmation: true;
  kind: 'payment' | 'schedule';
  planId?: string;
  invoiceId?: string;
  /** Sentence built by code, shown verbatim in the confirmation card. */
  sentence: string;
}

export interface AgentToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentReply {
  text: string;
  toolCalls: AgentToolCallRecord[];
  needsConfirmation?: NeedsConfirmation;
}

export interface AgentChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface TreasurerAgent {
  /** Executes a human-confirmed plan (through A's PaymentGuard). Never sees invoice text. */
  execute(plan: PaymentPlan, confirmation: Confirmation, emit: EmitFn): Promise<ExecutionResult>;
  chat(message: string, history: AgentChatTurn[], emit: EmitFn): Promise<AgentReply>;
}

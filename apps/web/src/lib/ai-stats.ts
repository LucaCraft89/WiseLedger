// "Local AI" panel numbers: speed and duration of the last analysis seen in this browser tab (memory only).
import type { AnalysisReport, AppEvent, HealthResponse } from '../api/contracts.js';

export interface AiRunStats {
  invoiceId: string;
  /** Streamed Analyst token events (one event ≈ one model token). */
  tokens: number;
  /** Model time: extraction + summary (rules are code, not AI). */
  seconds: number;
  /** tokens / seconds, or undefined when either is zero. */
  tokensPerSecond?: number;
  model: string;
}

/** Stats of one finished analysis from its live events and report timings; null when there is nothing to show. */
export function aiRunStats(
  events: readonly AppEvent[],
  report: Pick<AnalysisReport, 'invoiceId' | 'timings' | 'model'> | undefined,
): AiRunStats | null {
  if (!report?.timings) return null;
  const ms = (report.timings.extractMs ?? 0) + (report.timings.summaryMs ?? 0);
  if (ms <= 0) return null;
  const tokens = events.filter((e) => e.type === 'token' && e.agent === 'analyst').length;
  const seconds = ms / 1000;
  return {
    invoiceId: report.invoiceId,
    tokens,
    seconds,
    tokensPerSecond: tokens > 0 ? tokens / seconds : undefined,
    model: report.model.name,
  };
}

let lastRun: AiRunStats | null = null;

/** Remember the latest run (module state: gone on reload, never stored). */
export function recordAiRun(stats: AiRunStats | null): void {
  if (stats) lastRun = stats;
}

export function lastAiRun(): AiRunStats | null {
  return lastRun;
}

/** "12.3 tokens/s · 4.1 s" */
export function formatAiRun(s: AiRunStats): string {
  const speed = s.tokensPerSecond !== undefined ? `${s.tokensPerSecond.toFixed(1)} tokens per second · ` : '';
  return `${speed}${s.seconds.toFixed(1)} seconds of AI work`;
}

/** The one plain sentence about where the AI runs. Claims "on this computer" only for an on-device provider. */
export function localAiSentence(llm: Pick<HealthResponse['llm'], 'provider' | 'onDevice'>): string {
  if (llm.provider === 'mock') return 'Demo mode: canned answers, no AI model is running.';
  if (llm.onDevice) {
    return 'The invoice is read by an AI model running on this computer. Nothing is sent to the internet.';
  }
  return 'The AI model runs on another server: the invoice text is sent to it.';
}

/** Model warm state in plain words. */
export const MODEL_STATE_WORDS: Record<HealthResponse['llm']['state'], string> = {
  unloaded: 'not loaded yet',
  loading: 'loading (the first analysis waits for it)',
  ready: 'ready',
  error: 'could not start',
};

// Speech-to-text on this computer: QVAC Parakeet TDT (multilingual, ~0.6B, Q8). The text only fills the chat box;
// the user reads and edits it, then sends it through the normal Treasurer chat path (spending still needs a confirmation).
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_STT_MODEL = 'PARAKEET_TDT_0_6B_V3_Q8_0';
/** Parakeet wants 16 kHz mono 16-bit PCM in a WAV container. */
export const STT_SAMPLE_RATE = 16_000;
export const MAX_AUDIO_SECONDS = 30;
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MOCK_TRANSCRIPT = 'pay the latest invoice on Friday';

export type TranscribeErrorCode = 'AUDIO_INVALID' | 'AUDIO_TOO_LONG' | 'AUDIO_EMPTY' | 'STT_UNAVAILABLE' | 'STT_FAILED';

/** Error with a plain message the UI can show as is. */
export class TranscribeError extends Error {
  constructor(
    readonly code: TranscribeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranscribeError';
  }
  /** HTTP status for the transcribe route. */
  get status(): number {
    if (this.code === 'AUDIO_TOO_LONG') return 413;
    if (this.code === 'STT_UNAVAILABLE') return 503;
    if (this.code === 'STT_FAILED') return 500;
    return 400;
  }
}

export interface TranscribeResult {
  text: string;
  /** Wall time of this call (includes the model load on the first call). */
  ms: number;
}

export interface Transcriber {
  /** Audio bytes (WAV) or a path to a WAV file. Loads the model on the first call and keeps it loaded. */
  transcribe(audio: Uint8Array | string, mime?: string): Promise<TranscribeResult>;
  info(): {
    provider: 'qvac' | 'mock';
    model: string;
    state: 'unloaded' | 'loading' | 'ready' | 'error';
    loadMs?: number;
  };
  unload(): Promise<void>;
}

export interface TranscriberOptions {
  /** qvac | openai | mock (default from LLM_PROVIDER, else mock). openai = local qvac serve, so speech also uses the QVAC SDK. */
  provider?: 'qvac' | 'openai' | 'mock';
  /** @qvac/sdk model constant (env QVAC_STT_MODEL). */
  model?: string;
  maxSeconds?: number;
  /** Text the mock returns. */
  mockText?: string;
  onProgress?: (percentage: number) => void;
}

export function createTranscriber(opts: TranscriberOptions = {}): Transcriber {
  const kind = opts.provider ?? ((process.env.LLM_PROVIDER ?? 'mock') as TranscriberOptions['provider']);
  if (kind === 'mock') return new MockTranscriber(opts.mockText);
  return new QvacTranscriber(opts);
}

export class MockTranscriber implements Transcriber {
  constructor(private readonly text = MOCK_TRANSCRIPT) {}
  async transcribe(audio: Uint8Array | string): Promise<TranscribeResult> {
    if (typeof audio !== 'string' && audio.byteLength === 0) {
      throw new TranscribeError(
        'AUDIO_EMPTY',
        'We did not receive any sound. Hold the button and speak, then try again.',
      );
    }
    return { text: this.text, ms: 0 };
  }
  info() {
    return { provider: 'mock' as const, model: 'mock', state: 'ready' as const };
  }
  async unload() {}
}

type Sdk = typeof import('@qvac/sdk');

class QvacTranscriber implements Transcriber {
  private readonly model: string;
  private state: 'unloaded' | 'loading' | 'ready' | 'error' = 'unloaded';
  private loadMs: number | undefined;
  private modelId: string | undefined;
  private loading: Promise<string> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private sdk: Sdk | undefined;

  constructor(private readonly opts: TranscriberOptions) {
    this.model = opts.model ?? (process.env.QVAC_STT_MODEL || DEFAULT_STT_MODEL);
  }

  info() {
    return {
      provider: 'qvac' as const,
      model: this.model,
      state: this.state,
      ...(this.loadMs !== undefined ? { loadMs: this.loadMs } : {}),
    };
  }

  transcribe(audio: Uint8Array | string, mime?: string): Promise<TranscribeResult> {
    // One transcription at a time on the one loaded model.
    const run = this.queue.then(() => this.run(audio, mime));
    this.queue = run.catch(() => {});
    return run;
  }

  private async run(audio: Uint8Array | string, mime?: string): Promise<TranscribeResult> {
    const started = Date.now();
    const bytes = typeof audio === 'string' ? new Uint8Array(await readFile(audio)) : audio;
    const wav = toParakeetWav(bytes, mime, this.opts.maxSeconds ?? MAX_AUDIO_SECONDS);
    const modelId = await this.ensureLoaded();
    const dir = join(tmpdir(), 'wiseledger-voice');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}.wav`);
    await writeFile(file, wav);
    try {
      const sdk = await this.loadSdk();
      const text = await sdk.transcribe({ modelId, audioChunk: file });
      return { text: String(text).replace(/\s+/g, ' ').trim(), ms: Date.now() - started };
    } catch (err) {
      throw new TranscribeError(
        'STT_FAILED',
        `We could not turn your voice into text. Try again, or type your request. (${errMsg(err)})`,
      );
    } finally {
      await rm(file, { force: true });
    }
  }

  async unload(): Promise<void> {
    if (!this.modelId) return;
    const sdk = await this.loadSdk();
    await sdk.unloadModel({ modelId: this.modelId, clearStorage: false });
    this.modelId = undefined;
    this.loading = undefined;
    this.state = 'unloaded';
  }

  private async loadSdk(): Promise<Sdk> {
    this.sdk ??= await import('@qvac/sdk');
    return this.sdk;
  }

  private ensureLoaded(): Promise<string> {
    if (this.modelId) return Promise.resolve(this.modelId);
    this.loading ??= this.load().catch((err: unknown) => {
      this.loading = undefined;
      this.state = 'error';
      throw new TranscribeError(
        'STT_UNAVAILABLE',
        `The speech model could not start on this computer. You can still type your request. (${errMsg(err)})`,
      );
    });
    return this.loading;
  }

  private async load(): Promise<string> {
    this.state = 'loading';
    const t = Date.now();
    const sdk = await this.loadSdk();
    const modelSrc = (sdk as unknown as Record<string, unknown>)[this.model];
    if (!modelSrc) throw new Error(`Unknown QVAC model constant ${this.model}`);
    const loadModel = sdk.loadModel as unknown as (o: Record<string, unknown>) => Promise<string>;
    this.modelId = await loadModel({
      modelSrc,
      modelType: 'parakeet-transcription',
      ...(this.opts.onProgress
        ? { onProgress: (p: { percentage: number }) => this.opts.onProgress?.(p.percentage) }
        : {}),
    });
    this.loadMs = Date.now() - t;
    this.state = 'ready';
    return this.modelId;
  }
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 = integer PCM, 3 = IEEE float. */
  format: number;
  dataOffset: number;
  dataLength: number;
}

/** Reads a RIFF/WAVE header. Throws TranscribeError AUDIO_INVALID when it is not a WAV we can read. */
export function parseWav(bytes: Uint8Array): WavInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw notWav();
  let o = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataLength'> | undefined;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        format,
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw notWav();
      return { ...fmt, dataOffset: body, dataLength: Math.min(size, bytes.byteLength - body) };
    }
    o = body + size + (size % 2);
  }
  throw notWav();
}

const notWav = () =>
  new TranscribeError('AUDIO_INVALID', 'The recording could not be read. Please record again (WAV audio is expected).');

/** Any 16/32-bit PCM or float32 WAV → 16 kHz mono 16-bit WAV (downmix + linear resample). */
export function toParakeetWav(bytes: Uint8Array, mime: string | undefined, maxSeconds = MAX_AUDIO_SECONDS): Uint8Array {
  if (mime && !/wav|wave/i.test(mime) && !/octet-stream/i.test(mime)) {
    throw new TranscribeError(
      'AUDIO_INVALID',
      'This audio format is not supported yet. Please use the microphone button in WiseLedger, which records WAV.',
    );
  }
  if (bytes.byteLength === 0) {
    throw new TranscribeError(
      'AUDIO_EMPTY',
      'We did not receive any sound. Hold the button and speak, then try again.',
    );
  }
  const w = parseWav(bytes);
  const supported =
    (w.format === 1 && (w.bitsPerSample === 16 || w.bitsPerSample === 32)) ||
    (w.format === 3 && w.bitsPerSample === 32);
  if (!supported || w.channels < 1) throw notWav();
  const bps = w.bitsPerSample / 8;
  const frames = Math.floor(w.dataLength / (bps * w.channels));
  if (frames === 0) {
    throw new TranscribeError(
      'AUDIO_EMPTY',
      'We did not receive any sound. Hold the button and speak, then try again.',
    );
  }
  const seconds = frames / w.sampleRate;
  if (seconds > maxSeconds + 0.5) {
    throw new TranscribeError(
      'AUDIO_TOO_LONG',
      `That recording is ${Math.round(seconds)} seconds long. Please keep it under ${maxSeconds} seconds.`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset + w.dataOffset, frames * bps * w.channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < w.channels; c++) {
      const p = (i * w.channels + c) * bps;
      sum +=
        w.format === 3
          ? dv.getFloat32(p, true)
          : bps === 2
            ? dv.getInt16(p, true) / 32768
            : dv.getInt32(p, true) / 2147483648;
    }
    mono[i] = sum / w.channels;
  }
  if (w.sampleRate === STT_SAMPLE_RATE && w.channels === 1 && w.format === 1 && bps === 2) {
    return bytes.subarray(0, w.dataOffset + w.dataLength); // already right
  }
  return encodeWav16(resample(mono, w.sampleRate, STT_SAMPLE_RATE), STT_SAMPLE_RATE);
}

export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const out = new Float32Array(Math.max(1, Math.floor((input.length * to) / from)));
  const ratio = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = x - i0;
    out[i] = (input[i0] ?? 0) * (1 - f) + (input[i1] ?? 0) * f;
  }
  return out;
}

/** Mono float samples (-1..1) → 16-bit PCM WAV bytes. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + samples.length * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

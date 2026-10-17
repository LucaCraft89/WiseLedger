// Microphone → 16 kHz mono WAV in the browser (no dependency), for the on-device speech model (QVAC Parakeet).
// The transcript only fills the chat box: the user reads it, edits it, then sends it like typed text.

export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_MAX_SECONDS = 30;

/** True when this browser can record from a microphone. */
export function canRecordVoice(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/** Mono float samples (-1..1) → 16-bit PCM WAV bytes. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + samples.length * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  put(36, 'data');
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Recorded audio (webm/opus, ogg, mp4…) → 16 kHz mono WAV, decoded and resampled by the browser. */
export async function recordingToWav(blob: Blob, maxSeconds = VOICE_MAX_SECONDS): Promise<Blob> {
  const Ctx =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error('This browser cannot process audio. Please type your request.');
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const seconds = Math.min(decoded.duration, maxSeconds);
    const length = Math.max(1, Math.ceil(seconds * VOICE_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, length, VOICE_SAMPLE_RATE); // 1 channel: the browser downmixes
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return new Blob([encodeWav(rendered.getChannelData(0), VOICE_SAMPLE_RATE) as BlobPart], { type: 'audio/wav' });
  } finally {
    void ctx.close();
  }
}

/** Plain words for microphone failures. */
export function micErrorText(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked. Allow microphone access for this page in your browser, or type your request.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found on this computer. You can type your request instead.';
  }
  if (name === 'NotReadableError') {
    return 'The microphone is busy in another app. Close it there and try again, or type your request.';
  }
  return 'We could not record your voice. Try again, or type your request.';
}

export interface VoiceRecording {
  /** Stops and returns the recording as 16 kHz mono WAV. */
  stop(): Promise<Blob>;
  /** Stops and throws the audio away. */
  cancel(): void;
}

/** Starts the microphone. Stops on its own after maxSeconds (onAutoStop is called). */
export async function startRecording(onAutoStop: () => void, maxSeconds = VOICE_MAX_SECONDS): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
  });
  const release = () => {
    for (const t of stream.getTracks()) t.stop();
  };
  const timer = setTimeout(onAutoStop, maxSeconds * 1000);
  rec.start();
  const end = async () => {
    clearTimeout(timer);
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    release();
  };
  return {
    async stop() {
      await end();
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (!blob.size) throw new Error('We did not hear anything. Hold the button and speak, then try again.');
      return recordingToWav(blob, maxSeconds);
    },
    cancel() {
      void end();
    },
  };
}

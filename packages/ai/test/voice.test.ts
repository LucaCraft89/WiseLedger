import { describe, expect, it } from 'vitest';
import {
  createTranscriber,
  encodeWav16,
  MOCK_TRANSCRIPT,
  MockTranscriber,
  parseWav,
  STT_SAMPLE_RATE,
  TranscribeError,
  toParakeetWav,
} from '../src/voice.js';

const tone = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 0.5);

describe('voice: mock transcriber', () => {
  it('returns the fixed sentence for any audio', async () => {
    const stt = createTranscriber({ provider: 'mock' });
    await expect(stt.transcribe(encodeWav16(tone(1600), 16_000))).resolves.toEqual({ text: MOCK_TRANSCRIPT, ms: 0 });
    expect(stt.info().provider).toBe('mock');
  });
  it('refuses empty audio with a plain error', async () => {
    await expect(new MockTranscriber().transcribe(new Uint8Array())).rejects.toMatchObject({
      code: 'AUDIO_EMPTY',
      status: 400,
    });
  });
});

describe('voice: WAV handling', () => {
  it('encodes and parses a 16 kHz mono 16-bit WAV', () => {
    const wav = encodeWav16(tone(3200), 16_000);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(parseWav(wav)).toMatchObject({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      format: 1,
      dataOffset: 44,
      dataLength: 6400,
    });
  });
  it('passes 16 kHz mono through unchanged', () => {
    const wav = encodeWav16(tone(3200), 16_000);
    expect(toParakeetWav(wav, 'audio/wav')).toEqual(wav);
  });
  it('resamples 48 kHz to 16 kHz', () => {
    const out = toParakeetWav(encodeWav16(tone(48_000), 48_000), 'audio/wav');
    const info = parseWav(out);
    expect(info.sampleRate).toBe(STT_SAMPLE_RATE);
    expect(info.dataLength / 2).toBe(16_000);
  });
  it('rejects webm, garbage and long audio with plain messages', () => {
    expect(() => toParakeetWav(new Uint8Array(100), 'audio/webm')).toThrow(/not supported/);
    expect(() => toParakeetWav(new Uint8Array(100), 'audio/wav')).toThrow(TranscribeError);
    const long = encodeWav16(new Float32Array(16_000 * 40), 16_000);
    expect(() => toParakeetWav(long, 'audio/wav')).toThrow(/under 30 seconds/);
    try {
      toParakeetWav(long, 'audio/wav');
    } catch (err) {
      expect((err as TranscribeError).status).toBe(413);
    }
  });
});

describe.skipIf(process.env.LIVE_QVAC !== '1')('voice: live QVAC Parakeet', () => {
  it('transcribes the sample WAV', { timeout: 900_000 }, async () => {
    const stt = createTranscriber({ provider: 'qvac' });
    try {
      const r = await stt.transcribe(new URL('../spikes/voice-sample.wav', import.meta.url).pathname, 'audio/wav');
      expect(r.text.length).toBeGreaterThan(10);
    } finally {
      await stt.unload();
    }
  });
});

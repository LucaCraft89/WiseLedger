import { describe, expect, it } from 'vitest';
import { ApiCallError } from './api/client.js';
import { createFakeClient, FAKE_TRANSCRIPT } from './api/fake.js';
import { canRecordVoice, encodeWav, micErrorText, VOICE_SAMPLE_RATE } from './lib/voice.js';

describe('voice: WAV encoder', () => {
  const wav = encodeWav(Float32Array.from([0, 0.5, -0.5, 1, -1, 2]), VOICE_SAMPLE_RATE);
  const dv = new DataView(wav.buffer);
  const tag = (o: number) => new TextDecoder().decode(wav.subarray(o, o + 4));

  it('writes a 44-byte PCM header for 16 kHz mono 16-bit', () => {
    expect(wav.byteLength).toBe(44 + 6 * 2);
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(dv.getUint32(4, true)).toBe(36 + 12);
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(16_000);
    expect(dv.getUint32(28, true)).toBe(32_000);
    expect(dv.getUint16(34, true)).toBe(16);
    expect(dv.getUint32(40, true)).toBe(12);
  });
  it('clamps samples to 16-bit range', () => {
    expect(dv.getInt16(44, true)).toBe(0);
    expect(dv.getInt16(44 + 6, true)).toBe(32767);
    expect(dv.getInt16(44 + 8, true)).toBe(-32768);
    expect(dv.getInt16(44 + 10, true)).toBe(32767);
  });
});

describe('voice: plain errors and support', () => {
  it('explains a blocked or missing microphone', () => {
    expect(micErrorText({ name: 'NotAllowedError' })).toMatch(/blocked/);
    expect(micErrorText({ name: 'NotFoundError' })).toMatch(/No microphone/);
    expect(micErrorText(new Error('x'))).toMatch(/could not record/);
  });
  it('hides the mic where MediaRecorder does not exist (node)', () => {
    expect(canRecordVoice()).toBe(false);
  });
});

describe('voice: fake client', () => {
  it('returns the demo sentence and refuses empty audio', async () => {
    const api = createFakeClient({ stageDelayMs: 0, transferStepMs: 0, pollMs: 1 });
    const wav = new Blob([encodeWav(new Float32Array(160), VOICE_SAMPLE_RATE) as BlobPart], { type: 'audio/wav' });
    await expect(api.transcribe(wav)).resolves.toEqual({ text: FAKE_TRANSCRIPT, ms: 0 });
    expect(FAKE_TRANSCRIPT).toBe('pay the latest invoice on Friday');
    await expect(api.transcribe(new Blob([]))).rejects.toBeInstanceOf(ApiCallError);
  });
});

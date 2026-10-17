// Voice route on the mock transcriber (LLM_PROVIDER=mock): audio in → text out; empty and oversize refused in plain words.
import { MAX_AUDIO_BYTES, MOCK_TRANSCRIPT } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/server.js';

let built: App;
beforeEach(async () => {
  built = await createApp({ dbPath: ':memory:', mockStepMs: 0 });
});
afterEach(async () => {
  await built.app.close();
});

const wav = (bytes: number) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(Math.max(0, bytes - 4))]);

describe('POST /api/agent/transcribe', () => {
  it('returns the text for a recording', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/agent/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: wav(4096),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: MOCK_TRANSCRIPT });
  });

  it('an empty recording → 400 AUDIO_EMPTY', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/agent/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: Buffer.alloc(0),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('AUDIO_EMPTY');
  });

  it('a recording over the limit → 413 AUDIO_TOO_LONG with a plain message', async () => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/agent/transcribe',
      headers: { 'content-type': 'audio/wav' },
      payload: wav(MAX_AUDIO_BYTES + 1024),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'AUDIO_TOO_LONG' });
    expect(res.json().error.message).toMatch(/seconds/);
  });
});

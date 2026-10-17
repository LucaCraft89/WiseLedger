import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from './api/client.js';
import { readChatStream } from './api/client.js';
import type { ChatResponse } from './api/contracts.js';
import { connectServer } from './api/select.js';
import { createChatSession } from './lib/chat-session.js';
import type { StoredMessage } from './lib/chat-store.js';

const reply = (text: string): ChatResponse => ({ text, toolCalls: [] });

function slowApi() {
  let finish: (r: ChatResponse) => void = () => {};
  const api = {
    chatStream: vi.fn((_req, hooks: { onToken(t: string): void }) => {
      hooks.onToken('Your ');
      return new Promise<ChatResponse>((r) => {
        finish = r;
      });
    }),
  } as unknown as ApiClient;
  return { api, finish: (t: string) => finish(reply(t)) };
}

describe('chat session (outside the page)', () => {
  it('an answer that arrives after the page is gone still lands and is saved', async () => {
    const saved: StoredMessage[][] = [];
    const s = createChatSession(
      () => [],
      (m) => void saved.push([...m]),
    );
    const { api, finish } = slowApi();
    const p = s.send(api, 'balance?');
    expect(s.get()).toMatchObject({ busy: true, live: 'Your ' });
    // (the chat page unmounts here: nothing in the session depends on it)
    finish('Your balance is 737.00 TUSDT.');
    await p;
    expect(s.get().busy).toBe(false);
    expect(s.get().messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:balance?',
      'assistant:Your balance is 737.00 TUSDT.',
    ]);
    expect(saved.at(-1)?.length).toBe(2);
  });

  it('New chat drops an answer still on its way; a busy session ignores a second send', async () => {
    const s = createChatSession(
      () => [],
      () => {},
    );
    const { api, finish } = slowApi();
    const p = s.send(api, 'first');
    await s.send(api, 'second while busy');
    expect(api.chatStream).toHaveBeenCalledTimes(1);
    s.clear();
    finish('late answer');
    await p;
    expect(s.get().messages).toEqual([]);
    expect(s.get().busy).toBe(false);
  });

  it('a failed send keeps the question and shows the error', async () => {
    const s = createChatSession(
      () => [],
      () => {},
    );
    const api = { chatStream: () => Promise.reject(new Error('down')) } as unknown as ApiClient;
    await s.send(api, 'hello');
    expect(s.get().messages).toHaveLength(1);
    expect(s.get().error).toBeInstanceOf(Error);
  });
});

describe('chat stream reader', () => {
  it('tokens, a reset, then the reply; split across chunks', async () => {
    const lines = [
      '{"t":"token","text":"Hel"}',
      '{"t":"reset"}',
      '{"t":"token","text":"Hi"}',
      JSON.stringify({ t: 'reply', reply: reply('Hi') }),
    ].join('\n');
    const enc = new TextEncoder().encode(`${lines}\n`);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.slice(0, 7));
        c.enqueue(enc.slice(7));
        c.close();
      },
    });
    const seen: string[] = [];
    const r = await readChatStream(body, { onToken: (t) => seen.push(t), onReset: () => seen.push('|') });
    expect(seen).toEqual(['Hel', '|', 'Hi']);
    expect(r.text).toBe('Hi');
  });

  it('an error line becomes a plain error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"t":"error","code":"CHAT_FAILED","message":"The local AI is busy."}\n'));
        c.close();
      },
    });
    await expect(readChatStream(body, { onToken: () => {} })).rejects.toThrow('The local AI is busy.');
  });
});

describe('server connection', () => {
  it('keeps retrying (never falls back to the demo) and reports each failed attempt', async () => {
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new TypeError('connection refused');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const attempts: number[] = [];
      const client = await connectServer((n) => attempts.push(n), { delayMs: () => 1 });
      expect(client.mode).toBe('server');
      expect(attempts).toEqual([1, 2]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockWallet } from 'core/mocks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/server.js';
import { checkUpload } from '../src/uploads.js';

let dir: string;
let built: App;

function multipart(filename: string, data: Buffer, type = 'application/octet-stream') {
  const boundary = '----wiseledger';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\n1 0 obj\n', 'latin1');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiseledger-uploads-'));
  built = await createApp({ uploadDir: dir, dbPath: ':memory:', mockStepMs: 0, uploadMaxMb: 1 });
});

afterEach(async () => {
  await built.app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('checkUpload', () => {
  it('accepts PDF, PNG, JPEG, TXT and XML by extension and content', () => {
    expect(checkUpload('a.pdf', PDF)).toBe('pdf');
    expect(checkUpload('a.PNG', PNG)).toBe('image');
    expect(checkUpload('a.jpg', JPEG)).toBe('image');
    expect(checkUpload('a.jpeg', JPEG)).toBe('image');
    expect(checkUpload('a.txt', Buffer.from('Fattura n. 7 — €25'))).toBe('text');
    expect(checkUpload('a.xml', Buffer.from('﻿  <?xml version="1.0"?><Fattura/>'))).toBe('xml');
  });

  it('rejects other types and content that does not match the extension', () => {
    expect(() => checkUpload('a.exe', Buffer.from('MZ'))).toThrow(/PDF, PNG, JPEG, TXT or XML/);
    expect(() => checkUpload('invoice', Buffer.from('hi'))).toThrow(/without an extension/);
    expect(() => checkUpload('a.pdf', PNG)).toThrow(/not a PDF/);
    expect(() => checkUpload('a.png', JPEG)).toThrow(/not a PNG image/);
    expect(() => checkUpload('a.txt', Buffer.from([0x41, 0, 0x42]))).toThrow(/not a text/);
    expect(() => checkUpload('a.xml', Buffer.from('just words'))).toThrow(/not a XML/);
  });
});

describe('upload route', () => {
  it('415 with a plain message for an unsupported file', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/invoices', ...multipart('macro.docm', PNG) });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_FILE');
    expect(res.json().error.message).toMatch(/PDF, PNG, JPEG, TXT or XML/);
  });

  it('415 when the content does not match the extension', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/invoices', ...multipart('fake.pdf', PNG) });
    expect(res.statusCode).toBe(415);
  });

  it('413 with a plain message over UPLOAD_MAX_MB', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 10, 0x20)]);
    const res = await built.app.inject({ method: 'POST', url: '/api/invoices', ...multipart('big.pdf', big) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
    expect(res.json().error.message).toMatch(/larger than 1 MB/);
  });

  it('accepts a real PNG', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/invoices', ...multipart('scan.png', PNG) });
    expect(res.statusCode).toBe(201);
  });
});

describe('health fields', () => {
  it('shows model, state, backend, network and the wallet sync state', async () => {
    const body = (await built.app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(body.llm).toMatchObject({ provider: 'mock', model: 'mock-analyzer', state: 'ready' });
    expect(body.wallet).toMatchObject({ backend: 'mock', ready: true });
    expect(body.walletSync).toEqual({ lastSyncAt: null, lastError: null });
  });

  it('real backend path: sync loop state after a kick', async () => {
    const wallet = new MockWallet({ stepMs: 0 });
    const real = await createApp(
      { uploadDir: dir, dbPath: ':memory:', walletBackend: 'wdk-rgb', rgbNetwork: 'regtest', walletSyncMs: 60_000 },
      { providers: { wallet } },
    );
    try {
      await real.providers.sync?.kick();
      const body = (await real.app.inject({ method: 'GET', url: '/api/health' })).json();
      expect(body.wallet).toMatchObject({ backend: 'wdk-rgb', network: 'regtest' });
      expect(Date.parse(body.walletSync.lastSyncAt)).not.toBeNaN();
      expect(body.walletSync.lastError).toBeNull();
    } finally {
      await real.app.close();
    }
  });
});

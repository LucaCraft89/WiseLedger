import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssetInfo, InvoiceAnalyzer } from 'core';
import { MockAnalyzer, MockLlm, MockTreasurer, MockWallet } from 'core/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { StoreHistory } from '../src/history.js';
import { Orchestrator } from '../src/orchestrator.js';
import { buildRuleConfig, createProviders, ruleNetworks } from '../src/providers.js';
import { type App, createApp } from '../src/server.js';
import { InvoiceStore } from '../src/store.js';

const asset = (assetId: string, ticker = 'TUSDT'): AssetInfo => ({
  assetId,
  ticker,
  name: ticker,
  precision: 6,
  schema: 'NIA',
  balance: { settled: '0', future: '0', spendable: '0' },
});

describe('provider factory', () => {
  it('mock path: core mocks, no sync loop, mock model info', async () => {
    const store = new InvoiceStore(':memory:');
    const p = await createProviders(loadConfig({}), { history: new StoreHistory(store) });
    expect(p.wallet).toBeInstanceOf(MockWallet);
    expect(p.analyzer).toBeInstanceOf(MockAnalyzer);
    expect(p.sync).toBeNull();
    expect(p.llmInfo()).toMatchObject({ provider: 'mock', state: 'ready' });
    expect(p.problems()).toEqual([]);
    await p.close();
    store.close();
  });

  it('mock path wraps the MockTreasurer', async () => {
    const store = new InvoiceStore(':memory:');
    const p = await createProviders(loadConfig({}), { history: new StoreHistory(store) });
    expect(p.treasurer).not.toBeInstanceOf(MockTreasurer);
    expect(typeof p.treasurer.execute).toBe('function');
    await p.close();
    store.close();
  });

  it('rule config: allowlist from env, else the single NIA asset; networks per backend', () => {
    const base = { walletBackend: 'wdk-rgb', rgbNetwork: 'regtest', paymentCap: '5000000' } as const;
    const one = buildRuleConfig({ ...base, assetAllowlist: [] }, [asset('rgb:t')]);
    expect(one).toEqual({
      assetAllowlist: ['rgb:t'],
      paymentCap: '5000000',
      networks: ['regtest'],
      assets: { 'rgb:t': { ticker: 'TUSDT', precision: 6 } },
    });
    expect(buildRuleConfig({ ...base, assetAllowlist: [] }, [asset('rgb:a'), asset('rgb:b')]).assetAllowlist).toEqual(
      [],
    );
    expect(buildRuleConfig({ ...base, assetAllowlist: ['rgb:x'] }, [asset('rgb:t')]).assetAllowlist).toEqual(['rgb:x']);
    expect(ruleNetworks({ walletBackend: 'wdk-rgb', rgbNetwork: 'mutinynet' })).toEqual(['signet']);
    expect(ruleNetworks({ walletBackend: 'mock', rgbNetwork: 'mutinynet' })).toEqual(['mock']);
  });
});

describe('real Analyst path (injected scripted LLM, no QVAC)', () => {
  let dir: string;
  let built: App | undefined;
  afterEach(async () => {
    await built?.app.close();
    built = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('builds the real Analyst on the injected model (R1 blocks an invoice without RGB invoice)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wiseledger-providers-'));
    // Call 1: a valid extraction without an RGB invoice; call 2: the summary.
    const llm = new MockLlm({
      replies: [
        {
          json: {
            issuerName: 'Acme Srl',
            issuerVatId: null,
            issuerEmail: null,
            invoiceNumber: '7',
            issueDate: null,
            dueDate: null,
            currency: 'TUSDT',
            total: '25.00',
            lineItems: [],
            paymentMethod: 'unknown',
            rgbInvoice: null,
            iban: null,
            btcAddress: null,
            pressureLanguage: false,
            pressureQuote: null,
            confidence: 0.9,
          },
        },
        { json: { summary: 'Acme Srl asks for 25.00 TUSDT but gives no RGB invoice.', questionsForUser: [] } },
      ],
    });
    built = await createApp(
      { uploadDir: dir, dbPath: ':memory:', mockStepMs: 0, llmProvider: 'openai' },
      { providers: { llm } },
    );
    const health = (await built.app.inject({ method: 'GET', url: '/api/health' })).json();
    expect(health.llm).toMatchObject({ provider: 'mock', model: 'mock-llm', state: 'ready' });

    const res = await built.app.inject({
      method: 'POST',
      url: '/api/invoices',
      payload: { text: 'Invoice 7 from Acme Srl, total 25.00 TUSDT', filename: 'acme.txt' },
    });
    const id = res.json().invoiceId as string;
    await built.orchestrator.idle();
    const detail = (await built.app.inject({ method: 'GET', url: `/api/invoices/${id}` })).json();
    expect(llm.calls).toHaveLength(2);
    expect(detail.report.model).toEqual({ name: 'mock-llm', provider: 'mock' });
    expect(detail.report.flags.map((f: { code: string }) => f.code)).toContain('R1_RGB_INVOICE');
    expect(detail.invoice.state).toBe('BLOCKED');
  });
});

describe('report without a payment (AI_UNAVAILABLE)', () => {
  it('waits for the user without a plan; confirm → 409 AI_UNAVAILABLE; reject works', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiseledger-noplan-'));
    const store = new InvoiceStore(':memory:');
    const wallet = new MockWallet({ stepMs: 0 });
    await wallet.init();
    const analyzer: InvoiceAnalyzer = {
      async analyze(_src, ctx) {
        return {
          invoiceId: ctx.invoiceId,
          extraction: { issuer: {}, lineItems: [], payment: { method: 'unknown' }, fieldConfidence: {} },
          flags: [{ code: 'AI_UNAVAILABLE', severity: 'warn', message: 'The local AI could not read this invoice.' }],
          verdict: 'review',
          summary: 'The local AI could not read this invoice.',
          questionsForUser: [],
          model: { name: 'mock', provider: 'mock' },
          createdAt: new Date().toISOString(),
        };
      },
    };
    const orch = new Orchestrator({ store, analyzer, treasurer: new MockTreasurer(wallet), wallet, uploadDir: dir });
    const inv = await orch.createInvoice({ filename: 'x.txt', data: Buffer.from('x') });
    await orch.idle();
    expect(store.get(inv.id)?.state).toBe('AWAITING_CONFIRMATION');
    expect(store.get(inv.id)?.plan).toBeUndefined();
    await expect(orch.confirm(inv.id, { planId: 'x', override: true })).rejects.toMatchObject({
      status: 409,
      code: 'AI_UNAVAILABLE',
    });
    expect(orch.reject(inv.id, {}).state).toBe('REJECTED');
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('StoreHistory', () => {
  it('finds earlier invoices by sha256 and excludes the current one', async () => {
    const store = new InvoiceStore(':memory:');
    const at = new Date().toISOString();
    const base = { state: 'UPLOADED' as const, kind: 'text' as const, path: '/x', createdAt: at, updatedAt: at };
    store.insert({ ...base, id: 'a', filename: 'a.txt', sha256: 'f'.repeat(64) });
    store.insert({ ...base, id: 'b', filename: 'b.txt', sha256: 'f'.repeat(64) });
    const h = new StoreHistory(store);
    expect(await h.seen({ sha256: 'f'.repeat(64), excludeInvoiceId: 'b' })).toEqual([
      { invoiceId: 'a', matchedOn: 'sha256' },
    ]);
    expect(await h.seen({ sha256: 'e'.repeat(64) })).toEqual([]);
    expect(await h.payeeBook()).toEqual([]);
    store.close();
  });
});

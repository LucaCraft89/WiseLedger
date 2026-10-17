// M3.S1 side: labels, scheduled jobs, fiscal report (stores + routes), on temp DBs and the mock wallet.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnalysisReport, type AssetInfo, type Job, makePlan, type TransferInfo } from 'core';
import { MOCK_ASSET_ID } from 'core/mocks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletFiscalService } from '../src/fiscal.js';
import { SqliteJobStore } from '../src/jobs.js';
import { payeeTarget, SqliteLabelStore } from '../src/labels.js';
import { type App, createApp } from '../src/server.js';
import { chatInvoices, InvoiceStore, type StoredInvoice } from '../src/store.js';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiseledger-m3-'));
  dbPath = join(dir, 'db', 'app.db');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FIXED = () => new Date('2026-10-17T08:00:00.000Z');

function job(jobId: string, runAt: string, status: Job['status'] = 'pending'): Job {
  return {
    jobId,
    planId: `plan-${jobId}`,
    invoiceId: `inv-${jobId}`,
    runAt,
    status,
    createdAt: '2026-10-17T08:00:00.000Z',
    updatedAt: '2026-10-17T08:00:00.000Z',
  };
}

async function linkedInvoice(store: InvoiceStore, id: string, payee: string, invoiceNumber: string) {
  const plan = await makePlan({
    invoiceId: id,
    rgbInvoice: 'rgb:mock/rgb:mock-tusdt/25000000/4102444800',
    assetId: MOCK_ASSET_ID,
    amount: '25000000',
    payee: { name: payee },
    executeAt: 'now',
    labels: ['rent'],
  });
  const report = {
    invoiceId: id,
    extraction: { issuer: { name: payee }, invoiceNumber, total: '25.00', currency: 'TUSDT' },
    flags: [],
    verdict: 'ok',
    proposedPayment: { rgbInvoice: plan.rgbInvoice, assetId: MOCK_ASSET_ID, amount: '25000000', payee },
  } as unknown as AnalysisReport;
  const at = '2026-10-05T09:00:00.000Z';
  const inv: StoredInvoice = {
    id,
    state: 'PAID',
    filename: `${id}.txt`,
    kind: 'text',
    sha256: 'f'.repeat(64),
    path: `/tmp/${id}.txt`,
    createdAt: at,
    updatedAt: at,
    plan,
    report,
  };
  store.insert(inv);
}

describe('SqliteLabelStore', () => {
  it('persists labels across a reopen and normalizes payee targets and labels', async () => {
    const s1 = new InvoiceStore(dbPath);
    const l1 = new SqliteLabelStore(s1, FIXED);
    const e = await l1.set('t-1', [' office ', 'Office', '', 'travel'], 'Q4');
    expect(e).toEqual({ targetId: 't-1', labels: ['office', 'travel'], note: 'Q4', updatedAt: FIXED().toISOString() });
    await l1.set('payee:  ACME   Srl ', ['supplier']);
    s1.close();

    const s2 = new InvoiceStore(dbPath);
    const l2 = new SqliteLabelStore(s2);
    expect((await l2.get('t-1'))?.labels).toEqual(['office', 'travel']);
    expect((await l2.get(payeeTarget('acme srl')))?.labels).toEqual(['supplier']);
    expect((await l2.list()).map((x) => x.targetId)).toEqual(['payee:acme srl', 't-1']);
    // Empty list and no note removes the entry.
    await l2.set('t-1', []);
    expect(await l2.get('t-1')).toBeNull();
    s2.close();
  });

  it('effective labels = own ∪ plan ∪ payee', async () => {
    const store = new InvoiceStore(':memory:');
    const labels = new SqliteLabelStore(store);
    await linkedInvoice(store, 'inv-1', 'Acme Srl', '2026-042');
    store.linkTransfer('t-2', 'inv-1');
    await labels.set('t-2', ['office']);
    await labels.set(payeeTarget('ACME SRL'), ['supplier', 'Office']);
    expect(labels.payeeOf('t-2')).toBe('Acme Srl');
    expect(await labels.effectiveLabels('t-2')).toEqual(['office', 'rent', 'supplier']);
    expect(await labels.effectiveLabels('unlinked')).toEqual([]);
    store.close();
  });
});

describe('SqliteJobStore', () => {
  it('put / list / cancel / markDone, same semantics as MemoryJobStore, and survives a reopen', async () => {
    const s1 = new InvoiceStore(dbPath);
    const jobs = new SqliteJobStore(s1, FIXED);
    await jobs.put(job('b', '2026-10-20T10:00:00.000Z'));
    await jobs.put(job('a', '2026-10-18T10:00:00+02:00'));
    await jobs.put(job('c', '2026-10-25T10:00:00.000Z'));
    expect((await jobs.list()).map((j) => j.jobId)).toEqual(['a', 'b', 'c']);
    expect((await jobs.list({ dueBefore: '2026-10-20T10:00:00.000Z' })).map((j) => j.jobId)).toEqual(['a', 'b']);

    expect(await jobs.cancel('c')).toBe(true);
    expect(await jobs.cancel('c')).toBe(false);
    expect(await jobs.cancel('missing')).toBe(false);
    await jobs.markDone('a', { planId: 'plan-a', status: 'settled', transferId: 't-9' });
    await jobs.markDone('b', { planId: 'plan-b', status: 'failed', error: { code: 'X', message: 'No funds' } });
    expect(await jobs.cancel('a')).toBe(false);
    s1.close();

    const s2 = new InvoiceStore(dbPath);
    const again = new SqliteJobStore(s2);
    const all = await again.list();
    expect(all.map((j) => [j.jobId, j.status])).toEqual([
      ['a', 'done'],
      ['b', 'failed'],
      ['c', 'cancelled'],
    ]);
    expect(all[0]?.result?.transferId).toBe('t-9');
    expect(all[1]?.lastError).toBe('No funds');
    expect(all[2]?.updatedAt).toBe(FIXED().toISOString());
    expect((await again.list({ status: 'pending' })).length).toBe(0);
    s2.close();
  });
});

describe('WalletFiscalService', () => {
  const asset: AssetInfo = {
    assetId: MOCK_ASSET_ID,
    ticker: 'TUSDT',
    name: 'Test USDT',
    precision: 6,
    schema: 'NIA',
    balance: { settled: '0', future: '0', spendable: '0' },
  };
  const t = (p: Partial<TransferInfo> & Pick<TransferInfo, 'transferId' | 'createdAt'>): TransferInfo => ({
    assetId: MOCK_ASSET_ID,
    amount: '0',
    direction: 'outgoing',
    status: 'Settled',
    updatedAt: p.createdAt,
    ...p,
  });
  const transfers: TransferInfo[] = [
    t({ transferId: 't4', createdAt: '2026-10-11T00:00:00.000Z', direction: 'incoming', amount: '5000000' }),
    t({ transferId: 't1', createdAt: '2026-10-01T09:00:00.000Z', direction: 'issuance', amount: '1000000000' }),
    t({ transferId: 't2', createdAt: '2026-10-05T10:00:00.000Z', amount: '25000000', txid: 'ab'.repeat(32) }),
    t({ transferId: 't3', createdAt: '2026-10-06T10:00:00.000Z', amount: '13130000', status: 'Failed' }),
    {
      transferId: 't5',
      amount: '0',
      direction: 'incoming',
      status: 'WaitingCounterparty',
      createdAt: '2026-10-10T23:59:59.000Z',
      updatedAt: '2026-10-10T23:59:59.000Z',
    },
  ];
  const wallet = { listTransfers: async () => transfers, listAssets: async () => [asset] };

  async function service() {
    const store = new InvoiceStore(':memory:');
    const labels = new SqliteLabelStore(store);
    await linkedInvoice(store, 'inv-1', 'Acme, "Srl"', '2026-042');
    store.linkTransfer('t2', 'inv-1');
    await labels.set('t2', ['office']);
    await labels.set(payeeTarget('Acme, "Srl"'), ['supplier']);
    return { store, fiscal: new WalletFiscalService({ wallet, store, labels }) };
  }

  it('CSV: header, RFC 4180 quoting, range filter, Failed excluded', async () => {
    const { store, fiscal } = await service();
    const r = await fiscal.report('2026-10-01', '2026-10-10', 'csv');
    expect(r.filename).toBe('wiseledger-report-2026-10-01-2026-10-10.csv');
    expect(r.content).toBe(
      [
        'date,direction,assetId,ticker,amount,amountDisplay,counterparty,invoiceNumber,labels,transferId,txid,status,rate,rateSource',
        '2026-10-01,issuance,rgb:mock-tusdt,TUSDT,1000000000,1000.000000,,,,t1,,Settled,,',
        `2026-10-05,outgoing,rgb:mock-tusdt,TUSDT,25000000,25.000000,"Acme, ""Srl""",2026-042,office; rent; supplier,t2,${'ab'.repeat(32)},Settled,,`,
        '2026-10-10,incoming,,,0,,,,,t5,,WaitingCounterparty,,',
        '',
      ].join('\n'),
    );
    store.close();
  });

  it('includes Failed on request; a single day range; JSON format with every column', async () => {
    const { store, fiscal } = await service();
    const withFailed = await fiscal.report('2026-10-06', '2026-10-06', 'csv', { includeFailed: true });
    expect(withFailed.rows.map((x) => x.transferId)).toEqual(['t3']);
    expect((await fiscal.report('2026-10-06', '2026-10-06', 'csv')).rows).toEqual([]);

    const j = await fiscal.report('2026-10-05', '2026-10-11', 'json');
    expect(j.filename).toBe('wiseledger-report-2026-10-05-2026-10-11.json');
    const parsed = JSON.parse(j.content) as Record<string, unknown>[];
    expect(parsed.map((x) => x.transferId)).toEqual(['t2', 't5', 't4']);
    expect(parsed[0]).toEqual({
      date: '2026-10-05',
      direction: 'outgoing',
      assetId: MOCK_ASSET_ID,
      ticker: 'TUSDT',
      amount: '25000000',
      amountDisplay: '25.000000',
      counterparty: 'Acme, "Srl"',
      invoiceNumber: '2026-042',
      labels: ['office', 'rent', 'supplier'],
      transferId: 't2',
      txid: 'ab'.repeat(32),
      status: 'Settled',
      rate: '',
      rateSource: '',
    });
    expect(j.content.startsWith('[\n  {')).toBe(true);
    store.close();
  });

  it('fills rate columns only when a rate provider is given, and rejects bad ranges', async () => {
    const fiscal = new WalletFiscalService({ wallet, rateFor: () => ({ rate: '0.92', rateSource: 'fixed demo' }) });
    const r = await fiscal.report('2026-10-01', '2026-10-01', 'csv');
    expect(r.content.split('\n')[1]).toBe(
      '2026-10-01,issuance,rgb:mock-tusdt,TUSDT,1000000000,1000.000000,,,,t1,,Settled,0.92,fixed demo',
    );
    await expect(fiscal.report('2026-10-02', '2026-10-01', 'csv')).rejects.toThrow(RangeError);
    await expect(fiscal.report('2026-02-30', '2026-03-01', 'csv')).rejects.toThrow(RangeError);
  });
});

describe('M3 routes', () => {
  let built: App;

  beforeEach(async () => {
    built = await createApp({ uploadDir: dir, dbPath: ':memory:', mockStepMs: 0 });
  });

  afterEach(async () => {
    await built.app.close();
  });

  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    built.app.inject({ method, url, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

  async function payInvoice(): Promise<string> {
    const res = await inject('POST', '/api/invoices', {
      text: 'Invoice 2026-042, Acme Srl, 25.00 TUSDT',
      filename: 'ok-basic.txt',
    });
    const id = res.json().invoiceId as string;
    const wait = async (states: string[]) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const state = (await inject('GET', `/api/invoices/${id}`)).json().invoice.state as string;
        if (states.includes(state) || Date.now() > deadline) return state;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    expect(await wait(['AWAITING_CONFIRMATION', 'BLOCKED', 'FAILED'])).toBe('AWAITING_CONFIRMATION');
    const planId = (await inject('GET', `/api/invoices/${id}`)).json().plan.planId as string;
    expect((await inject('POST', `/api/invoices/${id}/confirm`, { planId })).statusCode).toBe(200);
    expect(await wait(['PAID', 'FAILED'])).toBe('PAID');
    return id;
  }

  it('exposes the stores on App and providers', () => {
    expect(built.providers.labels).toBe(built.labels);
    expect(built.providers.jobs).toBe(built.jobs);
    expect(built.providers.fiscal).toBe(built.fiscal);
  });

  it('labels: PUT per transfer and per payee, GET list, effective labels on /api/transfers', async () => {
    const id = await payInvoice();
    const transfer = (await inject('GET', '/api/transfers'))
      .json()
      .transfers.find((x: { invoiceId?: string }) => x.invoiceId === id);
    expect(transfer.labels).toEqual([]);

    const own = await inject('PUT', `/api/labels/${transfer.transferId}`, { labels: ['office'], note: 'October' });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ targetId: transfer.transferId, labels: ['office'], note: 'October' });
    const payee = await inject('PUT', '/api/labels/payee/Acme%20Srl', { labels: ['supplier'] });
    expect(payee.json()).toMatchObject({ targetId: 'payee:acme srl', labels: ['supplier'] });

    const list = (await inject('GET', '/api/labels')).json().labels as { targetId: string }[];
    expect(list.map((e) => e.targetId).sort()).toEqual(['payee:acme srl', transfer.transferId].sort());
    const after = (await inject('GET', '/api/transfers'))
      .json()
      .transfers.find((x: { invoiceId?: string }) => x.invoiceId === id);
    expect(after.labels).toEqual(['office', 'supplier']);
  });

  it('labels: plain-language 400s', async () => {
    const tooMany = await inject('PUT', '/api/labels/t-1', { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.message).toContain('at most 10 labels');
    const tooLong = await inject('PUT', '/api/labels/t-1', { labels: ['x'.repeat(41)] });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.message).toContain('at most 40 characters');
    expect((await inject('PUT', '/api/labels/t-1', { labels: 'office' })).statusCode).toBe(400);
  });

  it('fiscal: CSV and JSON downloads with Content-Disposition, /api/report alias, 400s', async () => {
    await payInvoice();
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const [from, to] = [day(-1), day(1)];
    const csv = await inject('GET', `/api/fiscal?from=${from}&to=${to}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe(`attachment; filename="wiseledger-report-${from}-${to}.csv"`);
    expect(csv.body.split('\n')[0]).toMatch(/^date,direction,assetId,/);
    expect(csv.body).toContain(',outgoing,rgb:mock-tusdt,TUSDT,25000000,25.000000,Acme Srl,');

    const json = await inject('GET', `/api/report?from=${from}&to=${to}&format=json`);
    expect(json.headers['content-type']).toContain('application/json');
    expect(json.headers['content-disposition']).toContain('.json"');
    expect((JSON.parse(json.body) as unknown[]).length).toBe(2);

    const bad = await inject('GET', '/api/fiscal?from=2026-13-01&to=2026-12-31');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain('YYYY-MM-DD');
    const reversed = await inject('GET', '/api/fiscal?from=2026-10-10&to=2026-10-01');
    expect(reversed.statusCode).toBe(400);
    expect(reversed.json().error.message).toContain('on or before');
    const fmt = await inject('GET', `/api/fiscal?from=${from}&to=${to}&format=xml`);
    expect(fmt.json().error.message).toContain('csv or json');
  });

  it('schedule: list, cancel (rejects the SCHEDULED invoice), 404 and 409', async () => {
    await built.jobs.put(job('j1', '2026-10-30T10:00:00.000Z'));
    await built.jobs.put(job('j2', '2026-10-29T10:00:00.000Z', 'done'));
    const list = (await inject('GET', '/api/schedule')).json();
    expect(list.jobs.map((j: Job) => j.jobId)).toEqual(['j2', 'j1']);
    expect((await inject('GET', '/api/schedule?status=pending')).json().jobs.length).toBe(1);
    expect((await inject('GET', '/api/schedule?status=nope')).statusCode).toBe(400);

    expect((await inject('POST', '/api/schedule/j1/cancel')).json()).toEqual({ ok: true });
    const again = await inject('POST', '/api/schedule/j1/cancel');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toContain('cancelled');
    expect((await inject('POST', '/api/schedule/missing/cancel')).statusCode).toBe(404);
  });

  it('agent chat stays hermetic on the mock path; validates the message', async () => {
    const res = await inject('POST', '/api/agent/chat', { message: 'What is my balance?' });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().text).toBe('string');
    expect(Array.isArray(res.json().toolCalls)).toBe(true);
    expect((await inject('POST', '/api/agent/chat', { message: '' })).statusCode).toBe(400);
  });

  it('chatInvoices() gives structured fields only, with the payment when payable', async () => {
    const id = await payInvoice();
    const inv = chatInvoices(built.store).find((x) => x.invoiceId === id);
    expect(inv).toMatchObject({ invoiceId: id, state: 'PAID', supplier: 'Acme Srl', payment: { amount: '25000000' } });
  });
});

import type { AppEvent } from 'core';
import { MockLlm, MockWallet } from 'core/mocks';
import { describe, expect, it } from 'vitest';
import { Analyst } from '../src/analyst/analyze.js';
import { QvacProvider } from '../src/llm/qvac.js';
import { EXPECTED, perfectAnswer, sourceOf } from './fixtures.js';
import { CONFIG, historyOf } from './helpers.js';

const NOW = new Date('2026-10-17T10:00:00Z');
const okVerdict = (expected: string | string[], actual: string) =>
  (Array.isArray(expected) ? expected : [expected]).includes(actual);
const history = historyOf([{ issuer: 'ACME SRL', number: '2026-042', invoiceId: 'inv_ok_basic_before' }]);

function analystWith(llm: MockLlm | QvacProvider) {
  return new Analyst({
    llm,
    wallet: new MockWallet({ now: () => NOW.getTime() }),
    history,
    config: CONFIG,
    now: () => NOW,
  });
}

describe('Analyst v1 with MockLlm', () => {
  for (const f of EXPECTED) {
    it(`${f.id} → ${JSON.stringify(f.verdict)}`, async () => {
      const llm = new MockLlm({
        replies: [
          { json: perfectAnswer(f) },
          { json: { summary: `Summary for ${f.id}.`, questionsForUser: ['Is this right?'] } },
        ],
      });
      const events: AppEvent[] = [];
      // Only `duplicate` was seen before (ok-basic paid earlier); other fixtures get an empty history.
      const analyst = f.seenBefore
        ? analystWith(llm)
        : new Analyst({
            llm,
            wallet: new MockWallet({ now: () => NOW.getTime() }),
            history: historyOf(),
            config: CONFIG,
            now: () => NOW,
          });
      const report = await analyst.analyze(sourceOf(f), { invoiceId: f.id }, (e) => events.push(e));
      expect(okVerdict(f.verdict, report.verdict), `${report.verdict} ${JSON.stringify(report.flags)}`).toBe(true);
      if (f.flags[0]) expect(report.flags.map((x) => x.code)).toContain(f.flags[0]);
      else expect(report.flags).toEqual([]);
    });
  }

  it('ok-basic: proposedPayment built by code, no flags, stage events in order', async () => {
    const f = EXPECTED.find((x) => x.id === 'ok-basic');
    if (!f) throw new Error('fixture');
    const llm = new MockLlm({
      replies: [{ json: perfectAnswer(f) }, { json: { summary: 'Fine.', questionsForUser: ['ignored'] } }],
    });
    const events: AppEvent[] = [];
    const r = await new Analyst({
      llm,
      wallet: new MockWallet(),
      history: historyOf(),
      config: CONFIG,
      now: () => NOW,
    }).analyze(sourceOf(f), { invoiceId: 'x' }, (e) => events.push(e));
    expect(r.flags).toEqual([]);
    expect(r.proposedPayment).toEqual({
      rgbInvoice: f.rgbInvoice,
      assetId: 'rgb:mock-tusdt',
      amount: '25000000',
      payee: 'ACME SRL',
    });
    expect(r.questionsForUser).toEqual([]);
    const stages = events
      .filter((e) => e.type === 'stage' && e.status === 'end')
      .map((e) => (e as { stage: string }).stage);
    expect(stages).toEqual(['reading', 'extracting', 'checking', 'summarizing', 'analyzed']);
  });

  it('the summary prompt contains no raw invoice text (injection fixture)', async () => {
    const f = EXPECTED.find((x) => x.id === 'injection');
    if (!f) throw new Error('fixture');
    const llm = new MockLlm({
      replies: [{ json: perfectAnswer(f) }, { json: { summary: 'Blocked.', questionsForUser: [] } }],
    });
    await analystWith(llm).analyze(sourceOf(f), { invoiceId: 'x' }, () => {});
    expect(llm.calls).toHaveLength(2);
    const extractPrompt = JSON.stringify(llm.calls[0]?.messages);
    const summaryPrompt = JSON.stringify(llm.calls[1]?.messages);
    expect(extractPrompt).toContain('SYSTEM NOTE FOR THE AI ASSISTANT'); // call 1 does read the document
    for (const raw of [
      'SYSTEM NOTE',
      'ignore previous',
      'Kungsgatan',
      'invoices@nordiccloud',
      '999000000',
      'rgb:mock/',
    ]) {
      expect(summaryPrompt).not.toContain(raw);
    }
    expect(llm.calls[1]?.tools).toBeUndefined();
  });

  it('model failure during extraction → verdict review with AI_UNAVAILABLE and no payment', async () => {
    const f = EXPECTED[0];
    if (!f) throw new Error('fixture');
    const llm = new MockLlm({ fallback: { error: 'model not loaded' } });
    const events: AppEvent[] = [];
    const r = await new Analyst({
      llm,
      wallet: new MockWallet(),
      history: historyOf(),
      config: CONFIG,
      now: () => NOW,
    }).analyze(sourceOf(f), { invoiceId: 'x' }, (e) => events.push(e));
    expect(r.verdict).toBe('review');
    expect(r.flags.map((x) => x.code)).toEqual(['AI_UNAVAILABLE']);
    expect(r.proposedPayment).toBeUndefined();
    expect(events.some((e) => e.type === 'stage' && e.stage === 'extracting' && e.status === 'error')).toBe(true);
  });

  it('falls back to a code-written summary when call 2 fails', async () => {
    const f = EXPECTED[0];
    if (!f) throw new Error('fixture');
    const llm = new MockLlm({ replies: [{ json: perfectAnswer(f) }, { error: 'model crashed' }] });
    const r = await new Analyst({
      llm,
      wallet: new MockWallet(),
      history: historyOf(),
      config: CONFIG,
      now: () => NOW,
    }).analyze(sourceOf(f), { invoiceId: 'x' }, () => {});
    expect(r.summary).toMatch(/ACME SRL asks for 25.00 TUSDT/);
  });
});

describe.skipIf(process.env.LIVE_QVAC !== '1')('Analyst v1 on live QVAC', () => {
  it('the six fixtures give the expected verdicts', { timeout: 1_200_000 }, async () => {
    const llm = new QvacProvider({ vision: true });
    const rows: string[] = [];
    let good = 0;
    for (const f of EXPECTED) {
      const t = Date.now();
      const analyst = f.seenBefore
        ? analystWith(llm)
        : new Analyst({
            llm,
            wallet: new MockWallet({ now: () => NOW.getTime() }),
            history: historyOf(),
            config: CONFIG,
            now: () => NOW,
            streamTokens: false,
          });
      const r = await analyst.analyze(sourceOf(f), { invoiceId: f.id }, () => {});
      const ok = okVerdict(f.verdict, r.verdict);
      if (ok) good++;
      rows.push(
        `| ${f.id} | ${JSON.stringify(f.verdict)} | ${ok ? '✅' : '❌'} ${r.verdict} | ${r.flags.map((x) => x.code).join(', ') || '-'} | ${((Date.now() - t) / 1000).toFixed(0)} s |`,
      );
    }
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const dir = resolve(import.meta.dirname, '../../../.data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'verdicts-live.md'),
      `| fixture | expected | actual | flags | time |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n${good}/6 (${llm.model})\n`,
    );
    await llm.unload();
    expect(good).toBe(6);
  });
});

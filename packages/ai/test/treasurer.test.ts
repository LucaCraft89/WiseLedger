import { type AppEvent, makePlan } from 'core';
import { MOCK_ASSET_ID, MockLlm, MockWallet, mockInvoice } from 'core/mocks';
import { describe, expect, it } from 'vitest';
import { QvacProvider } from '../src/llm/qvac.js';
import { confirmationGuard, Treasurer } from '../src/treasurer/treasurer.js';

async function setup(amount = '25000000') {
  const plan = await makePlan({
    invoiceId: 'inv_1',
    rgbInvoice: mockInvoice(MOCK_ASSET_ID, amount, 1_900_000_000),
    assetId: MOCK_ASSET_ID,
    amount,
    payee: { name: 'Acme Srl' },
    executeAt: 'now',
    labels: [],
  });
  const confirmation = { planId: plan.planId, confirmedAt: new Date().toISOString() };
  const guard = confirmationGuard();
  await guard.add(plan, confirmation);
  const wallet = new MockWallet({ stepMs: 0 });
  return { plan, confirmation, guard, wallet };
}

const callWith = (planId: string) => ({ toolCall: { name: 'execute_plan', arguments: { planId } } });

describe('Treasurer skeleton', () => {
  it('forces execute_plan, pays through the guard and follows to Settled', async () => {
    const { plan, confirmation, guard, wallet } = await setup();
    const llm = new MockLlm({ replies: [callWith(plan.planId)] });
    const events: AppEvent[] = [];
    const r = await new Treasurer({ llm, wallet, guard, pollMs: 0 }).execute(plan, confirmation, (e) => events.push(e));
    expect(r).toMatchObject({ planId: plan.planId, status: 'settled' });
    const req = llm.calls[0];
    expect(req?.toolChoice).toEqual({ name: 'execute_plan' });
    expect(req?.responseFormat).toBeUndefined();
    expect(JSON.stringify(req?.messages)).not.toContain('rgb:mock/'); // the model never sees the RGB invoice string
    expect(events.filter((e) => e.type === 'toolCall').map((e) => (e as { status: string }).status)).toEqual([
      'called',
      'ok',
    ]);
    expect(events.some((e) => e.type === 'transfer' && e.status === 'Settled')).toBe(true);
  });

  it('a wrong planId from the model is never executed; after 3 tries the result is failed and nothing is sent', async () => {
    const { plan, confirmation, guard, wallet } = await setup();
    const llm = new MockLlm({ fallback: callWith('someone-elses-plan') });
    const r = await new Treasurer({ llm, wallet, guard, pollMs: 0 }).execute(plan, confirmation, () => {});
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('TREASURER_PARSE');
    expect(llm.calls).toHaveLength(3);
    expect((await wallet.listTransfers()).filter((t) => t.direction === 'outgoing')).toHaveLength(0);
  });

  it('the guard rejects an unconfirmed plan and a second execution', async () => {
    const { plan, confirmation, wallet } = await setup();
    const empty = confirmationGuard();
    const llm = new MockLlm({ fallback: callWith(plan.planId) });
    const r1 = await new Treasurer({ llm, wallet, guard: empty, pollMs: 0 }).execute(plan, confirmation, () => {});
    expect(r1.error?.code).toBe('unknown_plan');

    const guard = confirmationGuard();
    await guard.add(plan, confirmation);
    const t = new Treasurer({ llm, wallet, guard, pollMs: 0 });
    expect((await t.execute(plan, confirmation, () => {})).status).toBe('settled');
    const again = await t.execute(plan, confirmation, () => {});
    expect(again.error?.code).toBe('already_executed');
  });

  it('a wallet failure becomes a failed result with the typed code', async () => {
    const { plan, confirmation, guard, wallet } = await setup('13130000'); // MockWallet failure amount
    const r = await new Treasurer({
      llm: new MockLlm({ fallback: callWith(plan.planId) }),
      wallet,
      guard,
      pollMs: 0,
    }).execute(plan, confirmation, () => {});
    expect(r.error?.code).toBe('TransferFailed');
  });
});

describe.skipIf(process.env.LIVE_QVAC !== '1')('Treasurer on live QVAC', () => {
  it('calls execute_plan with the confirmed planId in 5 of 5 runs, and a wrong plan surfaces as a guard rejection', {
    timeout: 900_000,
  }, async () => {
    const llm = new QvacProvider();
    const log: string[] = [];
    let good = 0;
    for (let i = 1; i <= 5; i++) {
      const { plan, confirmation, guard, wallet } = await setup(String(25_000_000 + i));
      const t = Date.now();
      const events: AppEvent[] = [];
      const r = await new Treasurer({ llm, wallet, guard, pollMs: 0, maxRetries: 0 }).execute(plan, confirmation, (e) =>
        events.push(e),
      );
      const calls = events
        .filter((e) => e.type === 'toolCall')
        .map((e) => `${(e as { name: string }).name}:${(e as { status: string }).status}`);
      if (r.status === 'settled') good++;
      log.push(`run ${i}: ${r.status} ${calls.join(' ')} ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
    // Wrong plan: the guard does not know it → failed result with the guard's reason, nothing sent.
    const { plan, confirmation, wallet } = await setup('26000000');
    const rejected = await new Treasurer({ llm, wallet, guard: confirmationGuard(), pollMs: 0 }).execute(
      plan,
      confirmation,
      () => {},
    );
    log.push(`unconfirmed plan: ${rejected.status} ${rejected.error?.code}`);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const dir = resolve(import.meta.dirname, '../../../.data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'treasurer-live.md'),
      `${log.join('\n')}\n\n${good}/5 (${llm.model}, no retries allowed)\n`,
    );
    await llm.unload();
    expect(good).toBe(5);
    expect(rejected.error?.code).toBe('unknown_plan');
  });
});

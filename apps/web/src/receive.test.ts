import { describe, expect, it } from 'vitest';
import { createFakeClient } from './api/fake.js';
import {
  canUse,
  likeHref,
  localTimeWithZone,
  mergePage,
  openFirst,
  parseGetPaid,
  RECEIVE_STATUS,
  receiveHref,
  receiveIdOf,
  whyNotUsable,
} from './lib/receive.js';
import { walletTab } from './WalletPage.js';

describe('payment requests: helpers', () => {
  it('status is icon + word + tone; copy and QR only while waiting', () => {
    expect(RECEIVE_STATUS.cancelled).toEqual({ icon: '○', word: 'Cancelled', tone: 'info' });
    expect(RECEIVE_STATUS.received.tone).toBe('ok');
    expect(canUse({ status: 'waiting' })).toBe(true);
    for (const status of ['incoming', 'received', 'expired', 'cancelled', 'failed'] as const) {
      expect(canUse({ status })).toBe(false);
      expect(whyNotUsable({ status })).toBeTruthy();
    }
    expect(whyNotUsable({ status: 'received', cancelledAt: '2026-10-18T10:00:00Z' })).toMatch(/after you cancelled/);
  });

  it('local time with the zone', () => {
    expect(localTimeWithZone('2026-10-18T07:08:09Z', 'Europe/Rome')).toBe('18 Oct 2026, 09:08 CEST');
    expect(localTimeWithZone('2026-10-18T07:08:09Z', 'UTC')).toBe('18 Oct 2026, 07:08 UTC');
  });

  it('open requests first, newest first; later pages appended without duplicates', () => {
    const r = (receiveId: string, status: 'waiting' | 'received' | 'expired', createdAt: string) => ({
      receiveId,
      status,
      createdAt,
    });
    const list = [
      r('a', 'received', '2026-10-18T10:00Z'),
      r('b', 'waiting', '2026-10-17T10:00Z'),
      r('c', 'expired', '2026-10-18T11:00Z'),
    ];
    expect(openFirst(list).map((x) => x.receiveId)).toEqual(['b', 'c', 'a']);
    expect(mergePage(list, [r('a', 'received', ''), r('d', 'waiting', '')]).map((x) => x.receiveId)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('routes: detail view, "make a new request like this", and the Get paid tab', () => {
    expect(parseGetPaid(receiveHref('rcv_1'))).toEqual({ receiveId: 'rcv_1' });
    expect(parseGetPaid(likeHref('rcv_1'))).toEqual({ like: 'rcv_1' });
    expect(parseGetPaid('#/wallet/get-paid')).toEqual({});
    expect(walletTab(receiveHref('rcv_1'))).toBe('get-paid');
    expect(walletTab(likeHref('rcv_1'))).toBe('get-paid');
    expect(walletTab('#/wallet/details')).toBe('details');
    expect(receiveIdOf({ receiveId: 'rcv_9', rgbInvoice: 'rgb:x' })).toBe('rcv_9');
    expect(receiveIdOf({ rgbInvoice: 'rgb:x' })).toBeUndefined();
  });
});

describe('payment requests: the demo backend behaves like the server', () => {
  it('45 requests page 20 · 20 · 5; cancel, refuse, archive → Older requests', async () => {
    const api = createFakeClient();
    for (let i = 0; i < 45; i++) await api.receive({ expiryMinutes: 60, note: `n${i}` });
    const p1 = await api.receives();
    const p2 = await api.receives({ before: p1.nextBefore });
    const p3 = await api.receives({ before: p2.nextBefore });
    expect([p1.receives.length, p2.receives.length, p3.receives.length]).toEqual([20, 20, 5]);
    expect(p3.nextBefore).toBeUndefined();
    const id = p1.receives[0]?.receiveId as string;
    expect((await api.receiveCancel(id)).status).toBe('cancelled');
    await expect(api.receiveCancel(id)).rejects.toThrow(/nothing to cancel/);
    expect((await api.receiveArchive(id)).archivedAt).toBeTruthy();
    expect((await api.receives({ archived: '1' })).receives.map((r) => r.receiveId)).toEqual([id]);
    expect((await api.receives({ status: 'open' })).receives).toHaveLength(20);
  });
});

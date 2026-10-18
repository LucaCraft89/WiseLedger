import { describe, expect, it } from 'vitest';
import { CHAT_KEEP, loadChat, saveChat } from './lib/chat-store.js';
import { receiveFromToolCall, toolLink } from './lib/ledger.js';

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('chat retention', () => {
  it('keeps the last conversation, marks it restored, clears on New chat', () => {
    const s = memory();
    expect(loadChat(s)).toEqual([]);
    saveChat(
      [
        { id: 1, role: 'user', text: 'balance?' },
        { id: 2, role: 'assistant', text: 'You can spend **975.00 TUSDT**.' },
      ],
      s,
    );
    expect(loadChat(s)).toEqual([
      { id: 1, role: 'user', text: 'balance?', restored: true },
      { id: 2, role: 'assistant', text: 'You can spend **975.00 TUSDT**.', restored: true },
    ]);
    saveChat([], s); // New chat
    expect(loadChat(s)).toEqual([]);
  });

  it(`keeps at most ${CHAT_KEEP} messages; broken or blocked storage starts empty`, () => {
    const s = memory();
    saveChat(
      Array.from({ length: CHAT_KEEP + 5 }, (_, i) => ({ id: i + 1, role: 'user' as const, text: `m${i}` })),
      s,
    );
    expect(loadChat(s)).toHaveLength(CHAT_KEEP);
    expect(loadChat(s)[0]?.text).toBe('m5');
    s.setItem('wiseledger.chat.v1', '{not json');
    expect(loadChat(s)).toEqual([]);
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    expect(loadChat(blocked)).toEqual([]);
    expect(() => saveChat([{ id: 1, role: 'user', text: 'x' }], blocked)).not.toThrow();
  });

  it('links what the Treasurer made; a payment request gets its own card (no chip link)', () => {
    expect(toolLink({ name: 'create_receive_invoice', ok: true })).toBeNull();
    expect(toolLink({ name: 'check_payment_request', ok: true, result: { invoiceId: 'inv_1' } })).toEqual({
      href: '#/invoice/inv_1',
      label: 'Open the check',
    });
    expect(toolLink({ name: 'label_transfer', ok: true })).toEqual({ href: '#/transfers', label: 'See transfers' });
    expect(toolLink({ name: 'create_receive_invoice', ok: false })).toBeNull();
    expect(receiveFromToolCall({ name: 'create_receive_invoice', ok: true, result: { rgbInvoice: 'rgb:x' } })).toBe(
      'rgb:x',
    );
    expect(receiveFromToolCall({ name: 'get_balance', ok: true, result: { rgbInvoice: 'rgb:x' } })).toBeUndefined();
  });
});

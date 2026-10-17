// Chat retention for #/chat: the conversation survives switching sections and reloads, in this browser only,
// until the user starts a new chat. Storage can be missing or blocked (private window): then chat simply starts empty.
import type { ChatResponse } from '../api/contracts.js';
import type { ChatTurn } from './ledger.js';

export interface StoredMessage extends ChatTurn {
  id: number;
  reply?: ChatResponse;
  /** Loaded from an earlier visit: its confirmation card is not offered again (ask the Treasurer again instead). */
  restored?: boolean;
}

const KEY = 'wiseledger.chat.v1';
export const CHAT_KEEP = 50;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const browserStore = (): Store | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function loadChat(store: Store | undefined = browserStore()): StoredMessage[] {
  try {
    const raw = store?.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (m): m is StoredMessage =>
          !!m &&
          typeof m === 'object' &&
          typeof (m as StoredMessage).id === 'number' &&
          ((m as StoredMessage).role === 'user' || (m as StoredMessage).role === 'assistant') &&
          typeof (m as StoredMessage).text === 'string',
      )
      .map((m) => ({ ...m, restored: true }));
  } catch {
    return [];
  }
}

export function saveChat(messages: readonly StoredMessage[], store: Store | undefined = browserStore()): void {
  try {
    if (messages.length === 0) store?.removeItem(KEY);
    else store?.setItem(KEY, JSON.stringify(messages.slice(-CHAT_KEEP)));
  } catch {
    // full or blocked storage: keep chatting without retention
  }
}

// The Treasurer conversation lives here, outside the chat page: a reply that arrives after the user switched
// section still lands in the conversation (and is saved), and coming back shows "Thinking…" or the live text.
import type { ApiClient } from '../api/client.js';
import { loadChat, type StoredMessage, saveChat } from './chat-store.js';
import { chatHistory } from './ledger.js';

export interface ChatSessionState {
  messages: StoredMessage[];
  /** A question is waiting for its answer. */
  busy: boolean;
  /** Reply text so far, while it streams in. */
  live: string;
  /** The last send failed (shown under the conversation until the next send). */
  error: unknown;
}

export function createChatSession(load: () => StoredMessage[] = loadChat, save = saveChat) {
  let state: ChatSessionState | undefined;
  let nextId = 0;
  /** Bumped by "New chat": an answer to a question from the cleared conversation is dropped. */
  let generation = 0;
  const listeners = new Set<() => void>();

  const get = (): ChatSessionState => {
    if (!state) {
      const messages = load();
      nextId = Math.max(0, ...messages.map((m) => m.id));
      state = { messages, busy: false, live: '', error: null };
    }
    return state;
  };
  const set = (patch: Partial<ChatSessionState>) => {
    state = { ...get(), ...patch };
    if (patch.messages) save(state.messages);
    for (const l of listeners) l();
  };

  return {
    get,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(api: ApiClient, text: string): Promise<void> {
      const message = text.trim();
      const s = get();
      if (!message || s.busy) return;
      const gen = generation;
      const history = chatHistory(s.messages);
      set({
        messages: [...s.messages, { id: ++nextId, role: 'user', text: message }],
        busy: true,
        live: '',
        error: null,
      });
      try {
        const reply = await api.chatStream(
          { message: message.slice(0, 2000), history },
          {
            onToken: (t) => gen === generation && set({ live: get().live + t }),
            onReset: () => gen === generation && set({ live: '' }),
          },
        );
        if (gen !== generation) return;
        set({
          messages: [...get().messages, { id: ++nextId, role: 'assistant', text: reply.text, reply }],
          busy: false,
          live: '',
        });
      } catch (err) {
        if (gen === generation) set({ busy: false, live: '', error: err });
      }
    },
    /** New chat: forget the conversation (an answer still on its way is dropped). */
    clear(): void {
      generation++;
      set({ messages: [], busy: false, live: '', error: null });
    },
  };
}

/** The one conversation of this browser tab. */
export const chatSession = createChatSession();

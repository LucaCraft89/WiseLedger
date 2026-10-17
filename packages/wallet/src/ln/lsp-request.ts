// The app's side of our LSP (scripts/lsp.ts): if this node has no channel with the LSP yet, connect and ask for
// one. Background, best effort: the LSP answers 503 while it prepares funds (one block), so we ask again.
import type { LnNode } from './node.js';

interface LspInfo {
  pubkey: string;
  host: string;
  peerPort: number;
}

export interface LspRequestOptions {
  url: string;
  log?: (msg: string) => void;
  /** Tries while the LSP is preparing (default 10, one per minute). */
  tries?: number;
  retryMs?: number;
}

/** Resolves with the LSP's answer status ('open', 'opening', 'exists', …) or throws a plain error. */
export async function requestLspChannel(node: LnNode, o: LspRequestOptions): Promise<string> {
  const get = async <T>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${o.url.replace(/\/$/, '')}${p}`, { ...init, signal: AbortSignal.timeout(60_000) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const info = (await get<LspInfo>('/info')).body;
  if ((await node.channels()).some((c) => c.peer_pubkey === info.pubkey)) return 'exists';
  const peer = `${info.pubkey}@${info.host}:${info.peerPort}`;
  for (let i = 0; i < (o.tries ?? 10); i++) {
    await node.call('connectPeer', peer).catch(() => undefined);
    const r = await get<{ status?: string; error?: { code: string; message: string } }>('/channel-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: node.pubkey }),
    });
    if (r.status === 202 || r.status === 200) {
      o.log?.(`Lightning: the LSP is opening a channel to this node (${r.body.status}).`);
      return r.body.status ?? 'opening';
    }
    if (r.status !== 503) throw new Error(`The LSP refused the channel: ${r.body.error?.message ?? r.status}`);
    o.log?.(`Lightning: ${r.body.error?.message ?? 'the LSP is preparing'} Asking again in a minute.`);
    await new Promise((res) => setTimeout(res, o.retryMs ?? 60_000));
  }
  throw new Error('The LSP did not open a channel in time; it will be asked again at the next start.');
}

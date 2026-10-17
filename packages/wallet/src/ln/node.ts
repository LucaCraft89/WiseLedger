// One RGB Lightning node (WDK RGB Lightning, a-003): its own data dir (seed 0600 + node state), its own process
// (folder lock), Mutinynet indexer/proxy. The native module is built from source and loaded from LN_MODULES
// (default ~/prove/lightning/node_modules): the compiled .node is never committed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lockWalletDir, unlockWalletDir } from '../lock.js';

type Call = (req?: unknown) => Promise<unknown>;
export type LnAccount = Record<string, Call>;

interface LnManagerCtor {
  new (seed: string, cfg: object): { getAccount(i: number): Promise<LnAccount> };
  getRandomSeedPhrase(n: number): string;
}

export interface LnNodeOptions {
  /** Short name for logs ("lsp", "app"). */
  name: string;
  dataDir: string;
  /** LDK peer port (one per node on a machine). */
  peerPort: number;
  indexerUrl?: string;
  transportEndpoint?: string;
  modulesDir?: string;
}

export interface LnChannel {
  channel_id: string;
  peer_pubkey: string;
  funding_txid?: string;
  ready: boolean;
  is_usable: boolean;
  capacity_sat: number;
  asset_id?: string;
  asset_local_amount?: number;
  asset_remote_amount?: number;
}

export interface LnPayment {
  payment_hash: string;
  status: string;
  inbound: boolean;
  asset_amount?: number;
  asset_id?: string;
}

export class LnNode {
  private constructor(
    readonly name: string,
    readonly dataDir: string,
    readonly pubkey: string,
    readonly peerPort: number,
    private readonly acct: LnAccount,
  ) {}

  /** Opens (or creates) the node in `dataDir` and unlocks it. Throws WalletInUse if another process holds it. */
  static async open(o: LnNodeOptions): Promise<LnNode> {
    const modules = o.modulesDir ?? process.env.LN_MODULES ?? path.join(os.homedir(), 'prove/lightning/node_modules');
    const entry = path.join(modules, '@utexo/wdk-rgb-lightning/index.js');
    if (!fs.existsSync(entry)) {
      throw new Error(
        `The RGB Lightning module is not installed at ${modules} (set LN_MODULES): it is built from source, see docs/decisions/a-003.`,
      );
    }
    const { default: Manager } = (await import(pathToFileURL(entry).href)) as { default: LnManagerCtor };
    fs.mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
    lockWalletDir(o.dataDir);
    const seedFile = path.join(o.dataDir, 'mnemonic');
    if (!fs.existsSync(seedFile)) fs.writeFileSync(seedFile, `${Manager.getRandomSeedPhrase(12)}\n`, { mode: 0o600 });
    const manager = new Manager(fs.readFileSync(seedFile, 'utf8').trim(), {
      network: 'signet',
      dataDir: path.join(o.dataDir, 'node'),
      ldkPeerListeningPort: o.peerPort,
    });
    const acct = await manager.getAccount(0);
    await acct.unlock?.({
      indexer_url: o.indexerUrl ?? process.env.RGB_INDEXER_URL ?? 'https://esplora.signet.kaleidoswap.com',
      proxy_endpoint:
        o.transportEndpoint ?? process.env.RGB_TRANSPORT_ENDPOINT ?? 'rpcs://proxy.kaleidoswap.com/json-rpc',
      announce_addresses: [],
      announce_alias: `wiseledger-${o.name}`,
    });
    const info = (await acct.getNodeInfo?.()) as { pubkey: string };
    return new LnNode(o.name, o.dataDir, info.pubkey, o.peerPort, acct);
  }

  call<T = unknown>(method: string, req?: unknown): Promise<T> {
    const fn = this.acct[method];
    if (!fn) throw new Error(`The Lightning node has no ${method}()`);
    return fn.call(this.acct, req) as Promise<T>;
  }

  address(): Promise<string> {
    return this.call<string>('getAddress');
  }

  async channels(): Promise<LnChannel[]> {
    return (await this.call<LnChannel[]>('listChannels')) ?? [];
  }

  async peers(): Promise<string[]> {
    const r = await this.call<{ pubkey: string }[] | { peers: { pubkey: string }[] }>('listPeers').catch(() => []);
    const list = Array.isArray(r) ? r : (r?.peers ?? []);
    return list.map((p) => p.pubkey);
  }

  async payments(): Promise<LnPayment[]> {
    return ((await this.call<LnPayment[]>('listPayments').catch(() => [])) as LnPayment[]) ?? [];
  }

  /** Vanilla (uncolored) and colored sats. */
  async btc(): Promise<{ vanilla: number; colored: number }> {
    const b = await this.call<{ vanilla?: { spendable?: number }; colored?: { spendable?: number } }>(
      'getBalanceDetails',
    );
    return { vanilla: Number(b?.vanilla?.spendable ?? 0), colored: Number(b?.colored?.spendable ?? 0) };
  }

  async assetBalance(
    assetId: string,
  ): Promise<{ spendable: number; offchainOutbound: number; offchainInbound: number }> {
    const b = await this.call<{ spendable?: number; offchain_outbound?: number; offchain_inbound?: number }>(
      'getAssetBalance',
      assetId,
    );
    return {
      spendable: Number(b?.spendable ?? 0),
      offchainOutbound: Number(b?.offchain_outbound ?? 0),
      offchainInbound: Number(b?.offchain_inbound ?? 0),
    };
  }

  async close(): Promise<void> {
    await this.call('shutdown').catch(() => undefined);
    unlockWalletDir(this.dataDir);
  }
}

// Startup self-check (M4.S2): what the demo still needs, in plain words. Runs at boot and every minute in the
// background (so /api/health stays fast), prints each finding once in the server log, and feeds /api/health
// `problems` (the UI shows them). Checks: test sats, the payment asset, free RGB UTXOs, indexer and proxy reachable.
import type { AssetInfo, WalletPort } from 'core';

export interface SelfCheckDeps {
  /** The open wallet; undefined until onboarding is done (nothing is checked before). */
  wallet: () => WalletPort | undefined;
  network: 'mutinynet' | 'regtest' | 'mock';
  indexerUrl?: string;
  transportEndpoint?: string;
  /** Allowed payment assets (empty: the one NIA asset held). */
  assetAllowlist: readonly string[];
  /** Below this many spendable sats a demo payment may fail (default 20,000). */
  minSats?: number;
  /** Below this many spendable base units of the payment asset (default 25 tokens at precision 6). */
  minAsset?: bigint;
  fetch?: typeof fetch;
  log?: { warn(msg: string): void; info(msg: string): void };
  intervalMs?: number;
}

/** BTC + free colorable UTXOs when the backend exposes them (WdkRgbWallet; not part of WalletPort). */
function chainFacts(wallet: WalletPort): { sats?: number; freeUtxos?: number } {
  const w = wallet as {
    btcBalance?: () => { vanilla?: { spendable?: number } };
    rgb?: { listUnspents?: () => { utxo: { colorable: boolean }; rgbAllocations: unknown[] }[] };
  };
  const out: { sats?: number; freeUtxos?: number } = {};
  try {
    const sats = w.btcBalance?.().vanilla?.spendable;
    if (typeof sats === 'number') out.sats = sats;
  } catch {
    // not exposed
  }
  try {
    const u = w.rgb?.listUnspents?.();
    if (u) out.freeUtxos = u.filter((x) => x.utxo.colorable && x.rgbAllocations.length === 0).length;
  } catch {
    // not exposed
  }
  return out;
}

/** rpcs://host/path → https://host/path (the RGB proxy speaks JSON-RPC over HTTPS). */
export function proxyHttpUrl(endpoint: string): string | undefined {
  const m = /^rpcs?:\/\/(.+)$/.exec(endpoint);
  if (!m) return undefined;
  return `${endpoint.startsWith('rpcs') ? 'https' : 'http'}://${m[1]}`;
}

async function reachable(f: typeof fetch, url: string, init?: RequestInit): Promise<boolean> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(5000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function paymentAsset(assets: readonly AssetInfo[], allowlist: readonly string[]): AssetInfo | undefined {
  if (allowlist.length > 0) return assets.find((a) => allowlist.includes(a.assetId));
  const nia = assets.filter((a) => a.schema === 'NIA');
  return nia.length === 1 ? nia[0] : undefined;
}

const tokens = (base: bigint, precision: number) => (Number(base) / 10 ** precision).toFixed(2);

export class SelfCheck {
  private findings: string[] = [];
  private printed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<string[]> | undefined;
  private address: string | undefined;

  constructor(private readonly deps: SelfCheckDeps) {}

  /** The latest findings (empty until the first run finishes). */
  problems(): string[] {
    return [...this.findings];
  }

  run(): Promise<string[]> {
    this.running ??= this.check()
      .then((f) => {
        this.findings = f;
        for (const p of f) if (!this.printed.has(p)) this.deps.log?.warn(`Self-check: ${p}`);
        this.printed = new Set(f);
        return f;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  start(): void {
    if (this.timer || this.deps.network === 'mock') return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.deps.intervalMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<string[]> {
    const d = this.deps;
    const wallet = d.wallet();
    if (d.network === 'mock' || !wallet) return [];
    const out: string[] = [];
    const f = d.fetch ?? fetch;

    const [indexerOk, proxyOk] = await Promise.all([
      d.indexerUrl && /^https?:\/\//.test(d.indexerUrl)
        ? reachable(f, `${d.indexerUrl.replace(/\/$/, '')}/blocks/tip/height`)
        : Promise.resolve(true),
      d.transportEndpoint && proxyHttpUrl(d.transportEndpoint)
        ? reachable(f, proxyHttpUrl(d.transportEndpoint) as string, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server.info', params: null }),
          })
        : Promise.resolve(true),
    ]);
    if (!indexerOk) {
      out.push(
        `The blockchain indexer (${d.indexerUrl}) does not answer. Check the internet connection, or set RGB_INDEXER_URL=https://mutinynet.com/api and restart.`,
      );
    }
    if (!proxyOk) {
      out.push(
        `The RGB proxy (${d.transportEndpoint}) does not answer: payments cannot reach the supplier. Check the internet connection.`,
      );
    }

    const { sats, freeUtxos } = chainFacts(wallet);
    const minSats = d.minSats ?? 20_000;
    if (sats !== undefined && sats < minSats) {
      try {
        this.address ??= await wallet.receiveAddress();
      } catch {
        // address is a nicety
      }
      const where =
        d.network === 'mutinynet'
          ? ` Get free test sats at https://faucet.mutinynet.com${this.address ? ` for ${this.address}` : ''}.`
          : ' On regtest: `pnpm wallet:smoke -- --fund-regtest`.';
      out.push(
        `The wallet has ${sats.toLocaleString('en-US')} test sats; a payment needs about ${minSats.toLocaleString('en-US')}.${where}`,
      );
    }
    if (freeUtxos === 0 && (sats ?? 0) < 3_000) {
      out.push('No free RGB slot (UTXO) and not enough sats to make one: add test sats first.');
    }

    try {
      const asset = paymentAsset(await wallet.listAssets(), d.assetAllowlist);
      const min = d.minAsset ?? 25_000_000n;
      if (!asset) {
        out.push(
          d.assetAllowlist.length > 0
            ? 'The wallet does not hold the asset in ASSET_ALLOWLIST yet: receive some, or check the asset ID.'
            : 'No test asset to pay with yet: run `pnpm -F wallet issue-asset` (or receive TUSDT).',
        );
      } else if (BigInt(asset.balance.spendable) < min && BigInt(asset.balance.future) < min) {
        // spendable alone drops to 0 while a payment settles (change is locked): only the future balance counts.
        out.push(
          `Only ${tokens(BigInt(asset.balance.spendable), asset.precision)} ${asset.ticker} can be spent right now (a demo payment is ${tokens(min, asset.precision)}). Wait for pending transfers to settle, or receive more.`,
        );
      }
    } catch {
      out.push('The wallet could not list its assets: the next sync will retry.');
    }
    return out;
  }
}

// Latency probe: prompt vs generated tokens and timing of Analyst call 1 and call 2 on a few fixtures.
import { MockWallet } from 'core/mocks';
import { extractInvoice } from '../src/analyst/extract.js';
import { summarize } from '../src/analyst/summarize.js';
import { loadInvoice } from '../src/extract/text.js';
import { createLlm } from '../src/llm/index.js';
import { EXPECTED, sourceOf } from '../test/fixtures.js';

void MockWallet;
const llm = createLlm('qvac', { vision: true });
await llm.warmUp?.();
const ids = (process.env.IDS ?? 'ok-basic,scam-bank-change,ok-eur').split(',');
for (const f of EXPECTED.filter((x) => ids.includes(x.id))) {
  const input = await loadInvoice(sourceOf(f));
  const orig = llm.complete.bind(llm);
  const stats: unknown[] = [];
  llm.complete = async (req) => {
    const t = Date.now();
    const r = await orig(req);
    if (process.env.SHOW) console.log(JSON.stringify(r.text));
    stats.push({ ms: Date.now() - t, ...(r as { stats?: object }).stats, chars: JSON.stringify(req.messages).length });
    return r;
  };
  const e = await extractInvoice(input, llm);
  await summarize(e.extraction, [], 'ok', llm);
  llm.complete = orig;
  console.log(f.id, JSON.stringify(stats));
}
await llm.unload?.();
process.exit(0);

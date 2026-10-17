// Load the model, stream a short answer, print load time, time to first token, tokens/s and RAM.
import { QvacProvider } from '../src/llm/qvac.js';
import { rssMb, secs, usedMb } from './util.js';

const before = usedMb();
const llm = new QvacProvider({ ctxSize: 4096 });
let t = Date.now();
await llm.warmUp();
console.log(
  `model ${llm.model} loaded+warm in ${secs(Date.now() - t)} s · system RAM +${usedMb() - before} MB · rss ${rssMb()} MB`,
);

t = Date.now();
let tokens = 0;
for await (const e of llm.stream({
  messages: [{ role: 'user', content: 'Explain in two sentences what an invoice is.' }],
})) {
  if (e.type === 'token') {
    tokens++;
    process.stdout.write(e.text);
  }
  if (e.type === 'done') {
    const s = e.result.stats ?? {};
    const genSecs = ((s.totalMs ?? 0) - (s.ttftMs ?? 0)) / 1000;
    console.log(
      `\n\nTTFT ${s.ttftMs} ms · ${tokens} chunks · ~${(tokens / genSecs).toFixed(1)} tok/s (sdk: ${s.tokensPerSecond?.toFixed?.(1) ?? 'n/a'}) · total ${secs(Date.now() - t)} s`,
    );
  }
}
console.log(`system RAM +${usedMb() - before} MB after generation`);
await llm.unload();
process.exit(0);

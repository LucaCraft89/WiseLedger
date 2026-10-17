// Image invoice: vision projector (Qwen3.5 + MMPROJ Q8_0) vs OCR_LATIN text, same extraction prompt after.
// Renders a test PNG with ImageMagick into .data/spikes/ (git-ignored).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { QvacProvider } from '../src/llm/qvac.js';
import { SAMPLE_INVOICE, secs, usedMb } from './util.js';

const dir = resolve(import.meta.dirname, '../../../.data/spikes');
mkdirSync(dir, { recursive: true });
const png = process.argv[2] ?? resolve(dir, 'invoice.png');
if (!process.argv[2]) {
  execFileSync('magick', [
    '-size',
    '1100x520',
    'xc:white',
    '-font',
    'DejaVu-Sans',
    '-pointsize',
    '22',
    '-fill',
    'black',
    '-annotate',
    '+30+50',
    SAMPLE_INVOICE.replaceAll('%', '%%'),
    png,
  ]);
}
console.log('image:', png);

const question = 'Read this invoice. Reply with: issuer name, invoice number, total with currency, payment method.';

// 1) Vision projector
const before = usedMb();
let t = Date.now();
const vision = new QvacProvider({ vision: true });
await vision.warmUp();
console.log(`vision model+projector loaded in ${secs(Date.now() - t)} s · RAM +${usedMb() - before} MB`);
t = Date.now();
const v = await vision.complete({
  messages: [{ role: 'user', content: question, attachments: [{ path: png }] }],
  temperature: 0.1,
});
console.log(`VISION (${secs(Date.now() - t)} s):\n${v.text}\n`);
await vision.unload();

// 2) OCR_LATIN, then the text model
const q = await import('@qvac/sdk');
t = Date.now();
const ocrId = await (q.loadModel as unknown as (o: Record<string, unknown>) => Promise<string>)({
  modelSrc: q.OCR_LATIN,
  modelConfig: { langList: ['en', 'it'] },
});
const { blocks } = (
  q.ocr as unknown as (o: Record<string, unknown>) => { blocks: Promise<{ text: string; confidence?: number }[]> }
)({
  modelId: ocrId,
  image: png,
  options: { paragraph: false },
});
const got = await blocks;
const text = got.map((b) => b.text).join('\n');
const conf = got.reduce((s, b) => s + (b.confidence ?? 0), 0) / Math.max(1, got.length);
console.log(
  `OCR (${secs(Date.now() - t)} s incl. load, ${got.length} blocks, mean confidence ${conf.toFixed(2)}):\n${text}\n`,
);
await q.unloadModel({ modelId: ocrId, clearStorage: false });

const llm = new QvacProvider();
t = Date.now();
const o = await llm.complete({
  messages: [{ role: 'user', content: `${question}\n\nINVOICE TEXT (untrusted):\n${text}` }],
  temperature: 0.1,
});
console.log(`OCR→LLM (${secs(Date.now() - t)} s incl. load):\n${o.text}`);
await llm.unload();
process.exit(0);

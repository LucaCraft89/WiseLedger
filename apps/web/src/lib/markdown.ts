// Tiny markdown subset for the Treasurer's chat replies: paragraphs, line breaks, - / 1. lists, # headings,
// **bold**, *italic*, `code`. Pure data out (no HTML strings), so nothing the model writes can inject markup.
// Links show their text only: a reply from the model never becomes a clickable URL.

export type Inline = { t: 'text' | 'b' | 'i' | 'code'; v: string };
export type Block =
  | { type: 'p'; lines: Inline[][] }
  | { type: 'h'; inl: Inline[] }
  | { type: 'ul' | 'ol'; items: Inline[][] };

const INLINE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<![\w*])\*(?![\s*])[^*\n]*[^\s*]\*(?![\w*])|(?<![\w_])_(?![\s_])[^_\n]*[^\s_]_(?![\w_]))/g;

export function parseInline(text: string): Inline[] {
  const plain = text.replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1'); // [text](url) → text
  const out: Inline[] = [];
  let last = 0;
  for (const m of plain.matchAll(INLINE)) {
    const s = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push({ t: 'text', v: plain.slice(last, at) });
    if (s.startsWith('`')) out.push({ t: 'code', v: s.slice(1, -1) });
    else if (s.startsWith('**') || s.startsWith('__')) out.push({ t: 'b', v: s.slice(2, -2) });
    else out.push({ t: 'i', v: s.slice(1, -1) });
    last = at + s.length;
  }
  if (last < plain.length) out.push({ t: 'text', v: plain.slice(last) });
  return out;
}

const UL = /^\s*[-*•]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const H = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let para: Inline[][] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', lines: para });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    const h = H.exec(line);
    if (!line.trim()) {
      flush();
    } else if (ul || ol) {
      flush();
      const type = ul ? 'ul' : 'ol';
      const item = parseInline((ul ?? ol)?.[1] ?? '');
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === type) prev.items.push(item);
      else blocks.push({ type, items: [item] });
    } else if (h) {
      flush();
      blocks.push({ type: 'h', inl: parseInline(h[1] ?? '') });
    } else {
      para.push(parseInline(line.trim()));
    }
  }
  flush();
  return blocks;
}

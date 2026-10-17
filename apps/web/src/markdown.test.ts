import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './lib/markdown.js';

describe('chat markdown', () => {
  it('bold, italic, code; snake_case and lone stars stay text', () => {
    expect(parseInline('Balance **975.00 TUSDT** on *Friday*, id `t_7`')).toEqual([
      { t: 'text', v: 'Balance ' },
      { t: 'b', v: '975.00 TUSDT' },
      { t: 'text', v: ' on ' },
      { t: 'i', v: 'Friday' },
      { t: 'text', v: ', id ' },
      { t: 'code', v: 't_7' },
    ]);
    expect(parseInline('invoice_id and other_x, 2 * 3 = 6')).toEqual([
      { t: 'text', v: 'invoice_id and other_x, 2 * 3 = 6' },
    ]);
  });

  it('lists, headings, paragraphs and line breaks', () => {
    const b = parseMarkdown('## Invoices\n- **ACME SRL**: 25.00\n- Nordic: blocked\n\nTotal:\n1. one\n2. two');
    expect(b.map((x) => x.type)).toEqual(['h', 'ul', 'p', 'ol']);
    expect(b[1]).toMatchObject({
      type: 'ul',
      items: [
        [
          { t: 'b', v: 'ACME SRL' },
          { t: 'text', v: ': 25.00' },
        ],
        [{ t: 'text', v: 'Nordic: blocked' }],
      ],
    });
    expect(parseMarkdown('line one\nline two')).toEqual([
      { type: 'p', lines: [[{ t: 'text', v: 'line one' }], [{ t: 'text', v: 'line two' }]] },
    ]);
  });

  it('links keep only their text; HTML stays plain text (rendered by React, never as markup)', () => {
    expect(parseInline('see [the explorer](https://evil.example)')).toEqual([{ t: 'text', v: 'see the explorer' }]);
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)>' }]);
  });
});

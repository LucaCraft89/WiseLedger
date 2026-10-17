import { Fragment } from 'react';
import { type Inline, parseMarkdown } from './lib/markdown.js';

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === 'b' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static render of one message, order never changes
          <strong key={i}>{p.v}</strong>
        ) : p.t === 'i' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <em key={i}>{p.v}</em>
        ) : p.t === 'code' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <code key={i}>{p.v}</code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <Fragment key={i}>{p.v}</Fragment>
        ),
      )}
    </>
  );
}

/** Renders a chat reply's markdown as React elements (never raw HTML). */
export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="wl-md">
      {blocks.map((b, i) => {
        // biome-ignore-start lint/suspicious/noArrayIndexKey: static render of one message
        if (b.type === 'h')
          return (
            <p key={i} style={{ margin: '4px 0', fontWeight: 600 }}>
              <Inlines parts={b.inl} />
            </p>
          );
        if (b.type === 'p')
          return (
            <p key={i} style={{ margin: '4px 0' }}>
              {b.lines.map((l, j) => (
                <Fragment key={j}>
                  {j > 0 && <br />}
                  <Inlines parts={l} />
                </Fragment>
              ))}
            </p>
          );
        const List = b.type === 'ul' ? 'ul' : 'ol';
        return (
          <List key={i} style={{ margin: '4px 0', paddingLeft: 20 }}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines parts={it} />
              </li>
            ))}
          </List>
        );
        // biome-ignore-end lint/suspicious/noArrayIndexKey: static render of one message
      })}
    </div>
  );
}

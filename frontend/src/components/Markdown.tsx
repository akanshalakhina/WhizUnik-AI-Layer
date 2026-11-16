import type { ReactNode } from 'react';

/**
 * Minimal, safe Markdown renderer for assistant answers and knowledge documents.
 * Builds React elements only (no innerHTML), so model or document text can never inject markup.
 * Supports: # headings, paragraphs, -/* bullet lists, 1. numbered lists, **bold**, *italic*, `code`.
 */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of src.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    const ul = /^[-*•]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] });
    } else if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (!list || list.kind !== kind) {
        flushList();
        list = { kind, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
    } else if (list && /^\s{2,}/.test(raw)) {
      // indented continuation of the previous list item
      list.items[list.items.length - 1] += ` ${t}`;
    } else {
      flushList();
      para.push(t);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

export default function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parse(text ?? '');
  return (
    <div className={`md ${className ?? ''}`.trim()}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        if (b.kind === 'h') {
          const Tag = (b.level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4';
          return <Tag key={k}>{inline(b.text, k)}</Tag>;
        }
        if (b.kind === 'p') return <p key={k}>{inline(b.text, k)}</p>;
        const List = b.kind;
        return (
          <List key={k}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it, `${k}-${j}`)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

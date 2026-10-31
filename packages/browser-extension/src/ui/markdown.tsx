import { Fragment, type ReactElement, type ReactNode } from "react";

/**
 * KOS's words in the side panel: the markdown a chat uses, built as React
 * elements so nothing KOS says can become markup. Paragraphs, headings,
 * lists, quotes, fenced code, tables kept as code, the small "-#" line
 * KOS writes for asides, inline code, bold, italics and links, and KOS's
 * references (@approval:6, @page:[Budget]) as the names they stand for.
 * What is not recognised stays as the text it was.
 */

type Block =
  | { kind: "p" | "small" | "quote"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

export function blocksOf(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) out.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    // A table reads as the grid it is drawn as.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const rows: string[] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!); i++) rows.push(lines[i]!.trim());
      i--;
      out.push({ kind: "code", text: rows.join("\n") });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "h", level: heading[1]!.length, text: heading[2]! });
      continue;
    }
    const small = /^-#\s+(.*)$/.exec(line);
    if (small) {
      flush();
      out.push({ kind: "small", text: small[1]! });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const last = out.at(-1);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[3]!);
      else out.push({ kind: "list", ordered, items: [item[3]!] });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const last = out.at(-1);
      if (last?.kind === "quote") last.text += `\n${quote[1]!}`;
      else out.push({ kind: "quote", text: quote[1]! });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|@([a-z]+):(?:\[([^\]\n]+)\]|([\w.:/-]*\w))/;

/** One line's inline marks, as elements. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index) out.push(rest.slice(0, m.index));
    const [whole, code, bold, italic, link, url, kind, named, id] = m;
    if (code) out.push(<code key={key++}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={key++}>{inline(bold.slice(2, -2))}</strong>);
    else if (italic) out.push(<em key={key++}>{inline(italic.slice(1, -1))}</em>);
    else if (link) {
      const at = link.indexOf("](");
      out.push(
        <a key={key++} href={link.slice(at + 2, -1)} target="_blank" rel="noreferrer">
          {inline(link.slice(1, at))}
        </a>,
      );
    } else if (url) {
      out.push(
        <a key={key++} href={url} target="_blank" rel="noreferrer">
          {url}
        </a>,
      );
    } else if (kind) {
      out.push(
        <span key={key++} className="mention">
          {named ?? `${kind} ${id}`}
        </span>,
      );
    }
    rest = rest.slice(m.index + whole.length);
  }
  return out;
}

function lines(text: string): ReactNode[] {
  return text.split("\n").map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(l)}
    </Fragment>
  ));
}

export function Markdown({ text }: { text: string }): ReactElement {
  return (
    <div className="md">
      {blocksOf(text).map((b, i) => {
        switch (b.kind) {
          case "p":
            return <p key={i}>{lines(b.text)}</p>;
          case "small":
            return (
              <p key={i} className="md-small">
                {inline(b.text)}
              </p>
            );
          case "quote":
            return <blockquote key={i}>{lines(b.text)}</blockquote>;
          case "h":
            return (
              <p key={i} className={`md-h md-h${b.level}`}>
                {inline(b.text)}
              </p>
            );
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "list": {
            const items = b.items.map((it, j) => <li key={j}>{inline(it)}</li>);
            return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
          }
        }
      })}
    </div>
  );
}

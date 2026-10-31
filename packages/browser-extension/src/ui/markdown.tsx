import { displayMathAt, listAt, MATH, mathOf, type MdList } from "@kos/shared";
import katex from "katex";
import { Fragment, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";

/**
 * KOS's words in the side panel: the markdown a chat uses, built as React
 * elements so nothing KOS says can become markup. Paragraphs, headings,
 * lists, quotes, fenced code, tables kept as code, the small "-#" line
 * KOS writes for asides, inline code, bold, italics and links, LaTeX math,
 * and KOS's references (@approval:6, @page:[Budget]) as the names they
 * stand for.
 * What is not recognised stays as the text it was.
 */

type Block =
  | { kind: "p" | "small" | "quote"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code" | "math"; text: string }
  | { kind: "list"; list: MdList };

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
    const math = displayMathAt(lines, i);
    if (math) {
      flush();
      out.push({ kind: "math", text: math.tex });
      i = math.next - 1;
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
    const list = listAt(lines, i);
    if (list) {
      flush();
      out.push({ kind: "list", list: list.list });
      i = list.next - 1;
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

/**
 * A formula, typeset by KaTeX as DOM nodes (render, never an HTML string),
 * with trust off, so a formula cannot carry a link, a class or a picture.
 * One KaTeX cannot read is shown as written, in its error colour.
 */
export function Tex({ source, display = false }: { source: string; display?: boolean }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current) katex.render(source, ref.current, { displayMode: display, throwOnError: false, trust: false, strict: "ignore" });
  }, [source, display]);
  return <span ref={ref} className="tex" />;
}

/** One line's inline marks, as elements. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    // Math first when it starts first, so $a_1$ is a formula and not italics.
    const math = MATH.exec(rest);
    if (math && (!m || math.index < m.index)) {
      if (math.index) out.push(rest.slice(0, math.index));
      const { tex, display } = mathOf(math);
      out.push(<Tex key={key++} source={tex} display={display} />);
      rest = rest.slice(math.index + math[0].length);
      continue;
    }
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

/** A list as the tree it is: each item's lines, then the lists under it. */
function ListView({ list }: { list: MdList }): ReactElement {
  const items = list.items.map((it, j) => (
    <li key={j}>
      {lines(it.text)}
      {it.lists.map((sub, k) => (
        <ListView key={k} list={sub} />
      ))}
    </li>
  ));
  return list.ordered ? <ol {...(list.start !== 1 ? { start: list.start } : {})}>{items}</ol> : <ul>{items}</ul>;
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
          case "math":
            return (
              <div key={i} className="md-math">
                <Tex source={b.text} display />
              </div>
            );
          case "list":
            return <ListView key={i} list={b.list} />;
        }
      })}
    </div>
  );
}

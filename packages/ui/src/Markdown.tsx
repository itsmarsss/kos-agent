import {
  createContext,
  Fragment,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";

import { COMMAND_NAMES } from "@kos/shared";

import { hrefFor } from "./routes.js";

/**
 * A small markdown renderer for chat.
 *
 * It builds React elements rather than HTML strings, so agent-authored text
 * can never inject markup: there is no dangerouslySetInnerHTML to get wrong.
 * The subset is what a conversation actually uses -- emphasis, code, lists,
 * quotes, headings, links -- and anything unrecognised stays literal text
 * rather than disappearing.
 */

/**
 * A reference the owner wrote with @, and a slash command.
 *
 * Rendered as chips so they read as things rather than as punctuation in the
 * middle of a sentence, and coloured by kind so a file is distinguishable from
 * a project at a glance.
 */
const MENTION =
  /@(project|page|file|schedule|chat|site|agent):(?:\[([^\]]+)\]|([A-Za-z0-9._/-]*[A-Za-z0-9_/-]))/;
/*
 * Built from the shared list rather than spelled out here. The private copy
 * went stale: /compact, /clear and /tools were added to the harness and the
 * renderer never learned them, so they were not recognised as commands.
 */
const COMMAND = new RegExp(`(^|\\s)(/(?:${COMMAND_NAMES.join("|")}))\\b`);

/**
 * What to call a reference, where the surface knows.
 *
 * A chat and an agent are addressed by id, and an id is not a name: a chip
 * reading "cmtjz26wu1:owner" tells the reader nothing. Whoever is rendering
 * usually has the list to hand, so they can supply the words.
 */
const Names = createContext<
  ((kind: string, id: string) => string | undefined) | null
>(null);

export function MentionNames({
  resolve,
  children,
}: {
  resolve: (kind: string, id: string) => string | undefined;
  children: ReactNode;
}): ReactElement {
  return <Names.Provider value={resolve}>{children}</Names.Provider>;
}

/**
 * A mark per kind.
 *
 * Seven kinds of reference in one colour scheme is four more than colour can
 * carry, and two of them (project and chat) sat on the same accent. Drawn
 * rather than emoji so they take the chip's own colour and line up with the
 * text beside them.
 */
function KindMark({ kind }: { kind: string }): ReactElement | null {
  const paths: Record<string, string> = {
    project: "M3 7h6l2 2h10v10H3z",
    page: "M6 3h8l4 4v14H6zM14 3v4h4",
    file: "M7 3h7l4 4v14H7zM13 3v5h5",
    schedule: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    chat: "M4 5h16v11H9l-5 4z",
    site: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c3 4 3 14 0 18M12 3c-3 4-3 14 0 18",
    agent: "M8 4h8v4H8zM5 8h14v9H5zM9 12h.01M15 12h.01M12 4V2",
  };
  const d = paths[kind];
  if (!d) return null;
  return (
    <svg
      className="chip-mark"
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function MentionChip({ kind, id }: { kind: string; id: string }): ReactElement {
  const resolve = useContext(Names);
  const label = resolve?.(kind, id) ?? id;
  return (
    <a
      className={`chip-ref chip-ref--${kind}`}
      href={refHref(kind, id)}
      title={`${kind}: ${id}`}
    >
      <KindMark kind={kind} />
      {label}
    </a>
  );
}

/** Where a reference goes when it is clicked. */
function refHref(kind: string, id: string): string {
  switch (kind) {
    case "page":
      return hrefFor({ name: "page", id });
    case "file":
      return hrefFor({ name: "files", path: id });
    case "schedule":
      return hrefFor({ name: "crons" });
    case "chat":
      return hrefFor({ name: "chats", id });
    case "agent":
      return hrefFor({ name: "agents", id: Number(id) });
    case "site":
      // Written as project/name, which is also where it lives. The site
      // server is a different origin, so this goes to the folder rather than
      // to a URL this page cannot know.
      return hrefFor({
        name: "files",
        path: `projects/${id.replace("/", "/sites/")}`,
      });
    case "project":
      return hrefFor({ name: "project", slug: id });
    default:
      return hrefFor({ name: "projects" });
  }
}

const BOLD_ITALIC = /(\*\*\*|___)(.+?)\1/;
const BOLD = /(\*\*|__)(.+?)\1/;
const ITALIC = /(?<![*\w])(\*|_)(?!\s)(.+?)(?<!\s)\1(?![*\w])/;
const STRIKE = /~~(.+?)~~/;
const CODE = /`([^`]+)`/;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const BARE_URL = /(https?:\/\/[^\s<>"']+)/;

/** Ordered by precedence; code wins so `**x**` inside backticks stays literal. */
const INLINE: Array<{
  re: RegExp;
  render: (m: RegExpExecArray, key: number) => ReactNode;
}> = [
  { re: CODE, render: (m, k) => <code key={k}>{m[1]}</code> },
  {
    re: MENTION,
    render: (m, k) => (
      // Bracketed or plain, whichever branch matched. A schedule is named by
      // its owner and usually has spaces, so the plain form cannot carry it.
      <MentionChip key={k} kind={m[1] ?? ""} id={m[2] ?? m[3] ?? ""} />
    ),
  },
  {
    re: COMMAND,
    render: (m, k) => (
      <Fragment key={k}>
        {m[1]}
        <span className="chip-ref chip-ref--command">{m[2]}</span>
      </Fragment>
    ),
  },
  {
    re: LINK,
    render: (m, k) => (
      <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer">
        {m[1]}
      </a>
    ),
  },
  { re: BOLD_ITALIC, render: (m, k) => <strong key={k}><em>{inline(m[2] ?? "")}</em></strong> },
  { re: BOLD, render: (m, k) => <strong key={k}>{inline(m[2] ?? "")}</strong> },
  { re: ITALIC, render: (m, k) => <em key={k}>{inline(m[2] ?? "")}</em> },
  { re: STRIKE, render: (m, k) => <del key={k}>{inline(m[1] ?? "")}</del> },
  {
    re: BARE_URL,
    render: (m, k) => (
      <a key={k} href={m[1]} target="_blank" rel="noopener noreferrer">
        {m[1]}
      </a>
    ),
  },
];

/** Apply inline rules left to right, recursing into what each one wraps. */
function inline(text: string, keySeed = 0): ReactNode[] {
  for (const rule of INLINE) {
    const match = rule.re.exec(text);
    if (!match) continue;
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    return [
      ...(before ? inline(before, keySeed + 1) : []),
      rule.render(match, keySeed),
      ...(after ? inline(after, keySeed + 2) : []),
    ];
  }
  return [text];
}

interface Block {
  render(key: number): ReactElement;
}

/** Group lines into blocks, respecting fenced code. */
function blocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence, or end of input for an unterminated block
      out.push({
        render: (k) => (
          <pre key={k} className="md-code" data-lang={lang || undefined}>
            <code>{body.join("\n")}</code>
          </pre>
        ),
      });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const text = heading[2] ?? "";
      out.push({
        render: (k) => {
          const Tag = (["h3", "h4", "h5"] as const)[level - 1] ?? "h5";
          return <Tag key={k} className="md-h">{inline(text)}</Tag>;
        },
      });
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push({
        render: (k) => (
          <blockquote key={k} className="md-quote">
            {inline(body.join(" "))}
          </blockquote>
        ),
      });
      continue;
    }

    // A pipe table: a header row, a dashed separator, then body rows. Without
    // this an agent's comparison table arrived as a screenful of raw pipes,
    // which is exactly the shape of answer a table is chosen for.
    const isRow = (l: string): boolean => /\|/.test(l) && l.trim().startsWith("|");
    const isDivider = (l: string): boolean =>
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");
    if (isRow(line) && isDivider(lines[i + 1] ?? "")) {
      const cells = (l: string): string[] =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const header = cells(line);
      const aligns = cells(lines[i + 1] ?? "").map((c) =>
        c.startsWith(":") && c.endsWith(":")
          ? "center"
          : c.endsWith(":")
            ? "right"
            : "left",
      );
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && isRow(lines[i] ?? "")) {
        body.push(cells(lines[i] ?? ""));
        i++;
      }
      out.push({
        render: (k) => (
          <div key={k} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {header.map((cell, n) => (
                    <th key={n} style={{ textAlign: aligns[n] ?? "left" }}>
                      {inline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, r) => (
                  <tr key={r}>
                    {header.map((_, n) => (
                      <td key={n} style={{ textAlign: aligns[n] ?? "left" }}>
                        {inline(row[n] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      });
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const start = ordered ? Number(/^\s*(\d+)/.exec(line)?.[1] ?? 1) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        if (re.test(current)) {
          items.push(current.replace(re, ""));
          i++;
          continue;
        }
        // A blank line between items is a loose list, not the end of one.
        // Ending the list there started a fresh <ol> per item, so a model
        // that spaced its list out was rendered as "1. 1. 1.".
        if (current.trim() === "") {
          let j = i;
          while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
          if (j < lines.length && re.test(lines[j] ?? "")) {
            i = j;
            continue;
          }
        }
        break;
      }
      out.push({
        render: (k) => {
          const Tag = ordered ? "ol" : "ul";
          return (
            <Tag key={k} className="md-list" {...(start !== 1 ? { start } : {})}>
              {items.map((item, n) => (
                <li key={n}>{inline(item)}</li>
              ))}
            </Tag>
          );
        },
      });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^\s*```/.test(lines[i] ?? "") &&
      !/^#{1,3}\s/.test(lines[i] ?? "") &&
      !/^\s*>\s?/.test(lines[i] ?? "") &&
      !bullet.test(lines[i] ?? "") &&
      !numbered.test(lines[i] ?? "") &&
      !(isRow(lines[i] ?? "") && isDivider(lines[i + 1] ?? ""))
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    out.push({
      render: (k) => (
        <p key={k} className="md-p">
          {para.map((l, n) => (
            <Fragment key={n}>
              {n > 0 && <br />}
              {inline(l)}
            </Fragment>
          ))}
        </p>
      ),
    });
  }

  return out;
}

export function Markdown({ text }: { text: string }): ReactElement {
  return <div className="md">{blocks(text).map((b, i) => b.render(i))}</div>;
}

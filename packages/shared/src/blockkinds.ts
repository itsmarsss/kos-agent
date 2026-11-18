import { valueOf, valuesOf, replaceBlocks, type KosBlock } from "./blocks.js";

/**
 * The kinds of typed block, and what each surface does with one.
 *
 * One table for every surface: the dashboard and KOS for Chrome draw a
 * block from it, the channels say it in plain words from it, and the prompt
 * names its kinds. KOS for Mac and the phone keep the same table in Swift
 * (KOSBlock.swift in DeviceKit); blockkinds.test.ts fails when the two drift. A kind
 * not in the table is drawn as a card from its fields, so KOS may coin one.
 */

/** How a block's body is drawn: as written (a draft is sent as it reads), as markdown, monospace, or by its lines. */
export type BodyStyle = "text" | "markdown" | "mono" | "checklist" | "steps" | "quote" | "diff";

/** What a block offers. Each is local or goes through a tool and its approval; none acts on its own. */
export type BlockAction = "copy" | "mail" | "send" | "ics" | "map";

export interface FieldSpec {
  key: string;
  label: string;
  /** A field that may repeat: drawn as its values in a row. */
  list?: boolean;
}

export interface BlockKind {
  name: string;
  /** The small head over the block; empty for a card, whose title heads it. */
  label: string;
  /** The first line of its plain words, where nothing draws it: "Draft email". */
  plain: string;
  /** Its known fields, in the order they are drawn. Any other field follows them. */
  fields: FieldSpec[];
  /** The field drawn as the block's title rather than as a row. */
  title?: string;
  body: BodyStyle;
  /** What Copy copies: the body (a draft, a command), or the whole block in words. */
  copies: "body" | "all";
  actions: BlockAction[];
}

const field = (key: string, label: string, list = false): FieldSpec => (list ? { key, label, list } : { key, label });

/** The kinds, in the order the prompt names them. */
export const BLOCK_KINDS: readonly BlockKind[] = [
  {
    name: "email",
    label: "Email",
    plain: "Draft email",
    fields: [field("to", "To", true), field("cc", "Cc", true), field("bcc", "Bcc", true), field("subject", "Subject")],
    body: "text",
    copies: "body",
    actions: ["copy", "mail", "send"],
  },
  {
    name: "message",
    label: "Message",
    plain: "Draft message",
    fields: [field("to", "To", true), field("channel", "Via")],
    body: "text",
    copies: "body",
    actions: ["copy", "send"],
  },
  {
    name: "event",
    label: "Event",
    plain: "Event",
    fields: [field("when", "When"), field("end", "Ends"), field("where", "Where"), field("notes", "Notes")],
    title: "title",
    body: "text",
    copies: "all",
    actions: ["copy", "ics"],
  },
  {
    name: "contact",
    label: "Contact",
    plain: "Contact",
    fields: [field("phone", "Phone", true), field("email", "Email", true), field("company", "Company"), field("address", "Address"), field("notes", "Notes")],
    title: "name",
    body: "text",
    copies: "all",
    actions: ["copy"],
  },
  {
    name: "address",
    label: "Address",
    plain: "Address",
    fields: [field("phone", "Phone"), field("notes", "Notes")],
    title: "name",
    body: "text",
    copies: "body",
    actions: ["copy", "map"],
  },
  { name: "checklist", label: "Checklist", plain: "Checklist", fields: [], title: "title", body: "checklist", copies: "body", actions: ["copy"] },
  { name: "steps", label: "Steps", plain: "Steps", fields: [], title: "title", body: "steps", copies: "body", actions: ["copy"] },
  { name: "quote", label: "Quote", plain: "Quote", fields: [field("source", "Source")], body: "quote", copies: "body", actions: ["copy"] },
  { name: "command", label: "Command", plain: "Command", fields: [field("cwd", "In")], body: "mono", copies: "body", actions: ["copy"] },
  { name: "diff", label: "Diff", plain: "Diff", fields: [], title: "file", body: "diff", copies: "body", actions: ["copy"] },
  { name: "card", label: "", plain: "", fields: [], title: "title", body: "markdown", copies: "all", actions: ["copy"] },
];

const BY_NAME = new Map(BLOCK_KINDS.map((k) => [k.name, k]));

/** A kind by name; one not in the table is a card under its own name, so nothing is drawn as a broken block. */
export function kindOf(name: string): BlockKind {
  const known = BY_NAME.get(name);
  if (known) return known;
  const card = BY_NAME.get("card") as BlockKind;
  const label = wordsOf(name);
  return { ...card, name, label, plain: label };
}

/** A key as a label: "follow-up" as "Follow up". */
function wordsOf(key: string): string {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One row of a block's header as drawn: its label and its values. */
export interface BlockRow {
  key: string;
  label: string;
  values: string[];
}

/** A link an `action: open <url> [words]` field asks for; only the web opens. */
export interface BlockLink {
  label: string;
  href: string;
}

/** A block as every surface draws it. */
export interface BlockView {
  kind: BlockKind;
  title?: string;
  rows: BlockRow[];
  body: string;
  links: BlockLink[];
}

const OPEN_ACTION = /^open\s+(https?:\/\/\S+)(?:\s+(.+))?$/i;

/** The header as rows: the kind's own fields in its order, then any other in the order written; the title and actions are not rows. */
export function viewOf(block: KosBlock): BlockView {
  const kind = kindOf(block.kind);
  const specs = new Map(kind.fields.map((f) => [f.key, f]));
  const keys = [...kind.fields.map((f) => f.key), ...block.fields.map(([k]) => k).filter((k) => !specs.has(k))];
  const rows: BlockRow[] = [];
  for (const key of new Set(keys)) {
    if (key === kind.title || key === "action") continue;
    const values = valuesOf(block, key);
    if (values.length) rows.push({ key, label: specs.get(key)?.label ?? wordsOf(key), values });
  }
  const links = valuesOf(block, "action").flatMap((a): BlockLink[] => {
    const m = OPEN_ACTION.exec(a);
    return m ? [{ href: m[1] ?? "", label: m[2]?.trim() || "Open" }] : [];
  });
  const title = kind.title ? valueOf(block, kind.title) : undefined;
  return { kind, ...(title ? { title } : {}), rows, body: block.body, links };
}

/**
 * A block in plain words, for a surface that cannot draw it: its heading,
 * a line per field, then the body after a blank line.
 *
 *     Draft email
 *     To: sam@example.com
 *     Subject: Saturday at 4
 *
 *     Hi Sam, ...
 */
export function plainOf(block: KosBlock): string {
  const view = viewOf(block);
  const heading = [view.kind.plain, view.title].filter(Boolean).join(": ");
  const head = [
    ...(heading ? [heading] : []),
    ...view.rows.map((r) => `${r.label}: ${r.values.join(", ")}`),
    ...view.links.map((l) => `${l.label}: ${l.href}`),
  ];
  return [head.join("\n"), view.body].filter(Boolean).join("\n\n");
}

/** A reply's typed blocks in plain words, for Discord, a text message and anything else that cannot draw them. */
export function blocksToText(text: string): string {
  return replaceBlocks(text, plainOf);
}

/** What Copy puts on the clipboard. */
export function copyOf(block: KosBlock): string {
  return kindOf(block.kind).copies === "body" && block.body ? block.body : plainOf(block);
}

/** The block as KOS writes it, to quote it back: the fence, the header, `---`, the body. */
export function sourceOf(block: KosBlock): string {
  const longest = Math.max(2, ...(block.body.match(/`{3,}/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const head = block.fields.map(([k, v]) => `${k}: ${v}`);
  return [`${fence}kos:${block.kind}`, ...head, "---", ...(block.body ? [block.body] : []), fence].join("\n");
}

/** A draft email as a `mailto:` link, for the owner's own mail app. */
export function mailtoOf(block: KosBlock): string {
  const to = valuesOf(block, "to").map(encodeURIComponent).join(",");
  const query = [
    ["cc", valuesOf(block, "cc").join(",")],
    ["bcc", valuesOf(block, "bcc").join(",")],
    ["subject", valueOf(block, "subject") ?? ""],
    ["body", block.body],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v ?? "")}`)
    .join("&");
  return `mailto:${to}${query ? `?${query}` : ""}`;
}

/** Where an address or a place is, on a map in the browser. */
export function mapOf(block: KosBlock): string | undefined {
  const place = [valueOf(block, "name"), block.body.replace(/\s*\n\s*/g, ", ")].filter(Boolean).join(", ");
  return place ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}` : undefined;
}

/**
 * The tool that would send this draft, from the tools this KOS has: one
 * whose name says mail and send for an email; for a message, the one for
 * its channel (notify reaches a Discord user or channel). Sending is a
 * request to KOS, whose call to that tool is tiered and approved as any
 * other; nothing here sends.
 */
export function sendToolOf(block: KosBlock, tools: readonly string[]): string | undefined {
  const sends = (name: string, what: RegExp): boolean => what.test(name) && /send/i.test(name);
  if (block.kind === "email") return tools.find((t) => sends(t, /mail/i));
  if (block.kind !== "message") return undefined;
  const channel = (valueOf(block, "channel") ?? "").toLowerCase();
  if (channel === "discord") return tools.find((t) => t === "notify");
  if (channel) return tools.find((t) => sends(t, new RegExp(channel.replace(/[^a-z0-9]/g, ""), "i")));
  return tools.find((t) => sends(t, /imessage|sms|message|text/i));
}

/** The owner's words asking KOS to send a draft with a tool, the draft quoted exactly. */
export function sendRequestOf(block: KosBlock, tool: string): string {
  const what = kindOf(block.kind).label.toLowerCase() || "draft";
  return `Send this ${what} as drafted, with ${tool}.\n\n${sourceOf(block)}`;
}

/** A checklist's items: `- [ ] words` or `- [x] words`; any other line is a line of words between them. */
export interface CheckItem {
  text: string;
  /** Undefined for a line that is not an item. */
  done?: boolean;
}

export function checklistOf(body: string): CheckItem[] {
  return body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const m = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line);
      return m ? { text: m[2] ?? "", done: m[1] !== " " } : { text: line.trim() };
    });
}

/** Steps, one a line, with any number or bullet they were written with taken off. */
export function stepsOf(body: string): string[] {
  return body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.replace(/^\s*(?:\d{1,3}[.)]|[-*+])\s+/, "").trim());
}

/** A diff line's sort: added, removed, a hunk's head, or context. */
export function diffLineOf(line: string): "add" | "del" | "hunk" | "same" {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  return "same";
}

const WALL = /^(?:<t:)?(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/;

interface Wall {
  y: number;
  mo: number;
  d: number;
  h?: number;
  mi?: number;
}

function wallOf(value: string | undefined): Wall | undefined {
  const m = WALL.exec(value?.trim() ?? "");
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  if (m[4] === undefined) return { y, mo, d };
  return { y, mo, d, h: Number(m[4]), mi: Number(m[5]) };
}

const two = (n: number): string => String(n).padStart(2, "0");
const dateOf = (w: Wall): string => `${w.y}${two(w.mo)}${two(w.d)}`;
/** Floating time: the clock the owner reads it on, as the block says it. */
const stampOf = (w: Wall): string => `${dateOf(w)}T${two(w.h ?? 0)}${two(w.mi ?? 0)}00`;

/** The day after, or an hour after, as an event with no end lasts. */
function laterOf(w: Wall): Wall {
  const at = new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h ?? 0, w.mi ?? 0));
  at.setTime(at.getTime() + (w.h === undefined ? 24 : 1) * 3_600_000);
  const next: Wall = { y: at.getUTCFullYear(), mo: at.getUTCMonth() + 1, d: at.getUTCDate() };
  return w.h === undefined ? next : { ...next, h: at.getUTCHours(), mi: at.getUTCMinutes() };
}

/** Text in an iCalendar value: backslash, semicolon, comma and line breaks escaped. */
const icsText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** A line folded at 75 characters, as RFC 5545 asks. */
function fold(line: string): string {
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += i === 0 ? 75 : 74) parts.push(line.slice(i, i + (i === 0 ? 75 : 74)));
  return parts.join("\r\n ");
}

/**
 * An event as an .ics file, or nothing when its `when` is not a date
 * (`2026-11-21`, `2026-11-21 16:00`, or a time token around one). A time
 * is floating: it is on whatever clock the calendar opening it keeps, which
 * is the owner's, as the block was written for them.
 */
export function icsOf(block: KosBlock, now: Date = new Date()): string | undefined {
  if (block.kind !== "event") return undefined;
  const start = wallOf(valueOf(block, "when"));
  if (!start) return undefined;
  const given = wallOf(valueOf(block, "end"));
  const end = given && (given.h === undefined) === (start.h === undefined) ? given : laterOf(start);
  const allDay = start.h === undefined;
  const title = valueOf(block, "title") ?? "Event";
  const notes = [valueOf(block, "notes"), block.body].filter(Boolean).join("\n\n");
  const where = valueOf(block, "where");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KOS//Typed blocks//EN",
    "BEGIN:VEVENT",
    `UID:${stampOf(start)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@kos`,
    `DTSTAMP:${stamp}`,
    allDay ? `DTSTART;VALUE=DATE:${dateOf(start)}` : `DTSTART:${stampOf(start)}`,
    allDay ? `DTEND;VALUE=DATE:${dateOf(end)}` : `DTEND:${stampOf(end)}`,
    `SUMMARY:${icsText(title)}`,
    ...(where ? [`LOCATION:${icsText(where)}`] : []),
    ...(notes ? [`DESCRIPTION:${icsText(notes)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** The note in the system prompt, on both engines: when to write a typed block, and which. */
export const BLOCKS_GUIDANCE = [
  "## Typed blocks",
  "A draft or a structured thing goes in a typed block, which every surface draws as that thing with its own Copy and actions: a fenced block whose info string is kos:<kind>, then `key: value` header lines (lowercase keys, one line each, a key repeated for a list), a line `---`, then the body exactly as it should read.",
  "An email or message draft is always kos:email (to, cc, bcc, subject) or kos:message (to, channel: imessage, sms or discord). Where one fits: kos:event (title, when and end as time tokens, <t:2026-11-21T16:00:f>, or a date alone for a whole day, where, notes), kos:contact (name, phone, email, company), kos:address (name; the address as the body), kos:checklist (title; `- [ ] item` lines), kos:steps (title; a step a line), kos:quote (source), kos:command (one command to run), kos:diff (file). Other structured output is kos:card (title, any fields, `action: open <url> <words>` for a link).",
  "Everything else stays ordinary markdown; never wrap prose or an answer in a block. Example:",
  "```kos:email\nto: sam@example.com\nsubject: Saturday at 4\n---\nHi Sam,\n\nStill on for Saturday at 4?\n```",
].join("\n");

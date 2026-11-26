import type { TaintSource } from "@kos/shared";

import { codeOf } from "../tools/fence.js";
import { hostOf } from "./rules.js";

/**
 * What a call read that the owner did not write, judged from the tool, its
 * arguments and what it answered: the sources a turn is tainted with
 * (risk/taint.ts). Read from the name, as beyondAutoRule is, for KOS's own
 * tools and every connected server; an error counts as a result, since a
 * server's or a site's error carries its words too.
 */

/** What the guard knows of a call's caller beside its arguments. */
export interface ReadContext {
  /** The host of the caller's browser tab, for a browser call. */
  site?: string;
  /** Table-name prefixes of projects a guest may write in (`leetcode_daily_`): rows read from them are guests' words. */
  guestTables?: readonly string[];
  /** Tables a tainted turn wrote: rows read from them are as untrusted as what that turn read. */
  taintedTables?: readonly string[];
}

/** Browser tools whose answer is KOS's own or the owner's, not a page's. */
const BROWSER_OWN = new Set(["browser.new_tab", "browser.handoff"]);

/** Workspace folders whose files came from outside: what the owner was sent, and what a browser downloaded. */
const INBOUND = /(^|[\/:\s"'])(uploads|downloads)\//im;

/** Google's services, by the words of a tool's name: mail, or a document of some kind. */
const MAIL = /gmail|mail|message|thread|draft/;

/** The first sender an email result names, an address alone. */
function senderIn(text: string): string | undefined {
  const m = /^\s*(?:from|sender)\s*:\s*(?:[^<\n]*<)?([^\s<>@"]+@[^\s<>"]+?)>?\s*$/im.exec(text);
  return m?.[1]?.toLowerCase();
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** The file name a path ends in. */
function baseName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/** The tables of guest projects a statement names: rows guests wrote, read back. */
function guestTablesIn(sql: string, prefixes: readonly string[]): string | undefined {
  if (!prefixes.length) return undefined;
  return namesIn(sql).find((n) => prefixes.some((p) => n.startsWith(p)));
}

/** The names a statement uses, lowercased, values and comments taken out. */
function namesIn(sql: string): string[] {
  return (codeOf(sql).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((n) => n.toLowerCase().replace(/^["`\[]|["`\]]$/g, ""));
}

/** Families whose answer is the owner's own data: memory, their chats, their artifacts, their tasks, what is kept. */
const PRIVATE_READS = ["memory.", "chats.read", "chats.search", "secrets.list", "artifacts.get", "tasks.list", "context.recall", "search."];

/**
 * Whether a call read the owner's own data: memory, their files, their
 * tables, other chats, a secret's list. A turn that has, and has read
 * outside text, has something to send and someone telling it where.
 */
export function readsPrivate(tool: string, input: Record<string, unknown>): boolean {
  if (PRIVATE_READS.some((p) => (p.endsWith(".") ? tool.startsWith(p) : tool === p))) return true;
  if (tool === "files.read") {
    const path = str(input, "path");
    return !path || !INBOUND.test(path);
  }
  // Any table may be the owner's, a guest project's joined to one included.
  return tool === "sql";
}

/** What this call read that the owner did not write, or undefined for a call whose answer is KOS's own. */
export function readFrom(tool: string, input: Record<string, unknown>, result: string, context: ReadContext = {}): TaintSource | undefined {
  if (tool === "http.fetch") {
    const url = str(input, "url");
    const host = url ? hostOf(url) : undefined;
    return { kind: "page", ...(host ? { where: host } : {}) };
  }
  // A tab's list, a switch and a fresh tab carry no page's text; a handoff answers with the owner's own words.
  if (BROWSER_OWN.has(tool)) return undefined;
  if (tool.startsWith("browser.")) {
    const url = str(input, "url");
    const host = context.site ?? (url ? hostOf(url) : undefined);
    return { kind: "page", ...(host ? { where: host } : {}) };
  }
  if (tool === "chrome.page" || tool === "computer.act") return { kind: "page", where: tool === "chrome.page" ? "your Chrome" : "your screen" };
  const mcp = /^mcp\.([^.]+)\.(.+)$/.exec(tool);
  if (mcp) {
    const [, server, name] = mcp as unknown as [string, string, string];
    if (server === "google") {
      if (MAIL.test(name)) {
        const from = senderIn(result);
        return { kind: "mail", ...(from ? { where: from } : {}) };
      }
      return { kind: "doc", where: /calendar|event/.test(name) ? "your Google Calendar" : "your Google Drive" };
    }
    return { kind: "server", where: server };
  }
  if (tool === "files.read") {
    const path = str(input, "path");
    return path && INBOUND.test(path) ? { kind: "file", where: baseName(path) } : undefined;
  }
  if (tool.startsWith("search.")) return INBOUND.test(result) ? { kind: "file", where: "a file in uploads or downloads" } : undefined;
  if (tool === "discord.messages" || tool === "discord.reactions" || tool === "discord.member") {
    const channel = str(input, "channel") ?? str(input, "channelId");
    return { kind: "guest", where: channel ? `people on the server in ${channel}` : "people on the server" };
  }
  if (tool === "sql") {
    const sql = str(input, "sql");
    const table = sql ? guestTablesIn(sql, context.guestTables ?? []) : undefined;
    if (table) return { kind: "rows", where: table };
    const stored = sql ? namesIn(sql).find((n) => (context.taintedTables ?? []).includes(n)) : undefined;
    return stored ? { kind: "stored", where: stored } : undefined;
  }
  if (tool === "artifacts.get") {
    const id = str(input, "id");
    return { kind: "file", where: id ? `artifact ${id}` : "an artifact" };
  }
  // A program that reads what came from outside brings its text in with its output.
  if (tool === "shell.run" || tool === "python.run") {
    const said = [str(input, "command"), str(input, "code"), str(input, "cwd")].filter(Boolean).join("\n");
    return INBOUND.test(said) ? { kind: "file", where: "a file in uploads or downloads" } : undefined;
  }
  if (tool === "chats.read" || tool === "chats.search") {
    const chat = str(input, "id") ?? str(input, "conversationId") ?? str(input, "query");
    return { kind: "chat", ...(chat ? { where: `the chat ${chat}` } : {}) };
  }
  if (tool === "kos.log") return { kind: "log" };
  if (tool === "daemons.logs") {
    const id = input["id"];
    return { kind: "program", where: typeof id === "number" || typeof id === "string" ? `daemon ${id}` : "a daemon" };
  }
  if (tool === "skills.run" || tool === "skills.test") {
    const name = str(input, "name");
    return { kind: "program", where: name ? `skill ${name}` : "a skill" };
  }
  return undefined;
}

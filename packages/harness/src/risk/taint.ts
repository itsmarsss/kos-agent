import { keptSources, registrableDomain, sameSource, TAINT_SOURCES_MAX, type TaintSource } from "@kos/shared";

import { codeOf, isKernelTable } from "../tools/fence.js";
import { addressesIn, beyondAutoByName } from "./beyondauto.js";
import { hostOf, writtenTables } from "./rules.js";
import type { RiskAssessment } from "./tiers.js";

/**
 * Taint the turn.
 *
 * A turn that has read text someone other than the owner wrote (a page, an
 * email, a guest's message, rows guests put in a table, a server's result)
 * may be carrying out that text's wishes rather than the owner's. Risk is
 * judged from the call alone, so reading could never widen what a call may
 * do; but Auto, a burst, a saved Always and a job's consent were given
 * before the text was read, and an injected instruction could ride them.
 * From the first such read to the end of the turn (its continuation after
 * an approval, and whatever it dispatches or hands off) none of them covers
 * a call that reaches outside: one that sends or posts where anyone but the
 * owner reads, writes outside the turn's folder, reaches the network,
 * changes KOS itself or touches a secret. Those ask, and the ask names what
 * the turn read. Reads stay free, and so does a post the owner alone reads:
 * that is the owner reading it.
 *
 * The browser's own taint (packages/browser/src/taint.ts) is the other
 * direction of the same idea: a tab a secret was filled into, held so the
 * secret cannot be read back out. This one is text read in, held so it
 * cannot act. A turn reading a tab reads the page through the same tools,
 * so both hold at once.
 */
export class Taint {
  private readonly read: TaintSource[] = [];
  private readonly links = new Set<string>();
  private privateRead = false;
  private readonly listeners: ((source: TaintSource) => void)[] = [];

  constructor(from: readonly TaintSource[] = []) {
    for (const source of from) this.mark(source);
  }

  /** Mark the turn as having read this. The same source once; past the cap, still tainted. */
  mark(source: TaintSource): void {
    if (this.read.length >= TAINT_SOURCES_MAX) return;
    const [kept] = keptSources([source]);
    if (!kept || this.read.some((s) => sameSource(s, kept))) return;
    this.read.push(kept);
    for (const told of this.listeners) told(kept);
  }

  /** Be told of each source as the turn reads it, and of those it already has: a chat keeping what its history holds. */
  onMark(told: (source: TaintSource) => void): void {
    this.listeners.push(told);
    for (const source of this.read) told(source);
  }

  /** Keep the addresses outside text named, as written: going to one carries nothing the turn read from the owner. */
  saw(text: string): void {
    for (const url of urlsIn(text)) {
      if (this.links.size >= LINKS_MAX) return;
      this.links.add(sameUrl(url));
    }
  }

  /** Whether outside text this turn named this address, exactly. */
  linked(url: string): boolean {
    return this.links.has(sameUrl(url));
  }

  /** Mark the turn as having read the owner's own data: memory, their files, their tables, other chats. */
  markPrivate(): void {
    this.privateRead = true;
  }

  /** Whether the turn has read the owner's own data, before or after its outside text. */
  get private(): boolean {
    return this.privateRead;
  }

  get tainted(): boolean {
    return this.read.length > 0;
  }

  /** What the turn read, oldest first. */
  get sources(): TaintSource[] {
    return [...this.read];
  }

  /** The sites of pages the turn read, by registrable domain: going back to one is not reaching anywhere new. */
  sites(): string[] {
    return this.read.flatMap((s) => (s.kind === "page" && s.where && /^[a-z0-9.-]+$/i.test(s.where) ? [registrableDomain(s.where.toLowerCase())] : []));
  }
}

/** The most addresses a turn keeps from what it read. */
const LINKS_MAX = 2000;

/** Every web address written out in a text: what a page links, or a call carries anywhere in its arguments. */
export function urlsIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>`)\]\\]+/gi) ?? [];
}

/** An address as two spellings of it compare: lowercased scheme and host, no trailing slash or punctuation. */
function sameUrl(url: string): string {
  const trimmed = url.replace(/[.,;:!?]+$/, "");
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}${u.hash}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** What the guard knows of a call beside its arguments, for judging it in a tainted turn. */
export interface TaintedCall {
  tool: string;
  input: Record<string, unknown>;
  assessment: RiskAssessment;
  /** The call names a secret. */
  secret: boolean;
  /** The host of the caller's browser tab, for a browser call. */
  site?: string;
  /** The owner's own words this turn, when it began from them: a site or an address they wrote is theirs to go to. */
  said?: string;
  /** The calling turn's folder, "" at the workspace root: a root chat's writes are held to scratch/ once tainted. */
  home?: string;
}

/** Why, in a tainted turn, a risky call asks though a saved yes would cover it. */
export interface TaintBar {
  why: string;
}

/** KOS's own tools whose risky calls stay inside the workspace, whatever the turn read: taint is carried, not stopped, by them. */
const LOCAL_FAMILIES = ["files.", "artifacts.", "tasks.", "memory.", "context.", "search.", "chats.", "export.", "tex."];

/** KOS's own families that change what KOS is, runs, or who may reach it. */
const KOS_FAMILIES = ["skills.", "modules.", "daemons.", "cron.", "blobs.", "systems.", "sites.", "builds.", "kos.", "improve.", "permissions."];

/** Discord tools that change the server's layout or who may see it, beside the posts. */
const DISCORD_CHANGES = new Set(["discord.audience", "discord.access", "discord.role", "discord.bind", "discord.make", "discord.sync", "discord.prune", "discord.listen"]);

/** Programs that can reach the network or write anywhere their run allows. Auto's run is local, not offline: loopback reaches out too. */
const PROGRAMS = new Set(["shell.run", "python.run"]);

/** Memory tools that write claims or pages, or fold, forget or archive them: what later turns are told. memory.remember keeps its claim as outside text's instead. */
const MEMORY_CHANGES = new Set(["memory.page", "memory.import_page", "memory.merge", "memory.forget", "memory.archive"]);

/** File tools that write, move or remove. */
const FILE_WRITES = new Set(["files.write", "files.edit", "files.mkdir", "files.cp", "files.mv", "files.rm"]);

/** The words a tainted turn's ask adds to its reason. */
export const TAINT_REASON = "the turn read text you did not write first, so no saved yes covers it";

function inFamily(tool: string, families: readonly string[]): boolean {
  return families.some((f) => (f.endsWith(".") ? tool.startsWith(f) : tool === f || tool.startsWith(`${f}.`)));
}

/** The site of a host, as a turn's reads are counted: its registrable domain. */
function siteOf(host: string): string {
  return registrableDomain(host.toLowerCase());
}

/** The sites the owner's words name: a domain or an address they wrote, whole, never a word that happens to be a site's name. */
function sitesNamed(said: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of (said ?? "").toLowerCase().matchAll(/(?:^|[^a-z0-9.@-])(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?=$|[^a-z0-9-])/g)) {
    out.add(siteOf(m[1]!));
  }
  return out;
}

/** Whether the owner's words name this host's site: its domain or an address on it, written out. */
export function namedBy(said: string | undefined, host: string): boolean {
  return sitesNamed(said).has(siteOf(host));
}

/** Whether everything the turn read is pages of this host's site: what it does there next is the reading going on. */
function readOnlyFrom(taint: Taint, host: string): boolean {
  const site = siteOf(host);
  return taint.sources.every((s) => s.kind === "page" && s.where !== undefined && /^[a-z0-9.-]+$/i.test(s.where) && siteOf(s.where) === site);
}

/** Every address a browser call names: under its address keys, and written anywhere in it (a script, text typed into a form). */
function browserAddresses(input: Record<string, unknown>): string[] {
  const out = new Set(addressesIn(input));
  const walk = (v: unknown): void => {
    if (typeof v === "string") for (const url of urlsIn(v)) out.add(url);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(input);
  return [...out];
}

/**
 * Why going to this address asks in a tainted turn, or false. Free: an
 * address the owner wrote, one outside text linked as written (it carries
 * nothing of the owner's), and the front page of a site the turn has been
 * on. Anything else could carry what the turn read, in its path, its query
 * or its fragment, or reach a site nobody named.
 */
export function addressAsks(url: string, call: Pick<TaintedCall, "site" | "said">, taint: Taint): string | false {
  const said = call.said ?? "";
  if (said && urlsIn(said).some((u) => sameUrl(u) === sameUrl(url))) return false;
  if (taint.linked(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return `opens ${url.slice(0, 60)}`;
  }
  const host = parsed.hostname.toLowerCase();
  const known = new Set(taint.sites());
  if (call.site) known.add(siteOf(call.site));
  if (!known.has(siteOf(host)) && !namedBy(call.said, host)) return `opens ${host}, a site this turn had not been on`;
  if (parsed.search || parsed.hash) return `opens an address on ${host} that carries data in its query`;
  if (parsed.pathname.replace(/\/+$/, "") !== "") return `opens an address on ${host} that nothing it read linked`;
  return false;
}

/** The first address of a call that asks in a tainted turn, as the card says it, or false. */
function addressesAsk(urls: readonly string[], call: Pick<TaintedCall, "site" | "said">, taint: Taint): string | false {
  for (const url of urls) {
    const why = addressAsks(url, call, taint);
    if (why) return why;
  }
  return false;
}

/** A file path as a root chat's write names it, from the workspace's root. */
function rootPath(path: string): string {
  return path.replace(/^workspace:/i, "").replace(/\\/g, "/").replace(/^(\.?\/)+/, "");
}

/** Whether a root chat's file call writes outside scratch/: what a tainted one asks for. */
function writesOutsideScratch(call: Pick<TaintedCall, "tool" | "input" | "home">): boolean {
  if (call.home !== "" || !FILE_WRITES.has(call.tool)) return false;
  const targets = ["path", "to", "from"].flatMap((k) => (typeof call.input[k] === "string" ? [call.input[k] as string] : []));
  return targets.some((p) => p.startsWith("/") || p.includes("..") || !/^scratch(\/|$)/i.test(rootPath(p)));
}

/**
 * Why a call the risk rules let run unasked asks in a tainted turn, or
 * false: a browser step to an address that could carry what the turn read
 * or reach a site nobody named, a root chat's write outside scratch/, and
 * work set up for later. A post the owner alone reads stays unasked.
 */
export function taintRaises(call: Pick<TaintedCall, "tool" | "input" | "site" | "said" | "home">, taint: Taint): string | false {
  if (!taint.tainted) return false;
  const { tool } = call;
  if (tool.startsWith("browser.") || /^mcp\.[^.]*browser/.test(tool)) {
    const why = addressesAsk(browserAddresses(call.input), call, taint);
    if (why) return why;
  }
  if (writesOutsideScratch(call)) return "writes in the workspace outside scratch/";
  if (tool === "cron.schedule") return "schedules work that runs later without you";
  if (tool === "blobs.create") return "sets up a standing helper";
  if (tool === "improve.suggest") return "suggests work for later";
  if (MEMORY_CHANGES.has(tool)) return "changes what KOS remembers";
  return false;
}

/**
 * Why a risky call asks in a tainted turn though Auto, a burst, a saved
 * Always or a job's consent would have covered it, or false where it stays
 * inside the workspace and they still may. Every call this does not know
 * to be inside is outside.
 */
export function taintBars(call: TaintedCall, taint: Taint): TaintBar | false {
  if (!taint.tainted) return false;
  const { tool, input, assessment } = call;
  if (call.secret || assessment.asksAlways) return { why: "uses a secret" };
  if (assessment.reached) return { why: "writes outside this chat's folder" };
  if (writesOutsideScratch(call)) return { why: "writes in the workspace outside scratch/" };
  if (tool === "sql") {
    const sql = typeof input["sql"] === "string" ? input["sql"] : "";
    return writtenTables(codeOf(sql)).some(isKernelTable) || assessment.reason === "writes KOS's own tables" ? { why: "changes KOS's own tables" } : false;
  }
  if (MEMORY_CHANGES.has(tool)) return { why: "changes what KOS remembers" };
  if (inFamily(tool, LOCAL_FAMILIES)) return false;
  if (tool.startsWith("browser.")) {
    const address = addressesAsk(browserAddresses(input), call, taint);
    if (address) return { why: address };
    // Acting on a site the owner named, after reading only that site and nothing of theirs, is browsing; anything else asks.
    const browsing = call.site !== undefined && !taint.private && namedBy(call.said, call.site) && readOnlyFrom(taint, call.site);
    return browsing ? false : { why: "acts on a page after reading text you did not write" };
  }
  if (PROGRAMS.has(tool)) return { why: "runs a program that can reach the network" };
  if (tool === "notify" || tool.startsWith("discord.")) return { why: DISCORD_CHANGES.has(tool) ? "changes who sees what on the server" : "posts where others read" };
  if (tool === "http.fetch") {
    const url = typeof input["url"] === "string" ? input["url"] : "";
    const host = url ? hostOf(url) : undefined;
    // Reading on from the one site the turn has read, at an address it linked, with nothing of the owner's read: reading. Anything else reaches out.
    const method = String(input["method"] ?? "GET").toUpperCase();
    const reads = (method === "GET" || method === "HEAD") && (input["body"] === undefined || input["body"] === null || input["body"] === "");
    if (host && reads && !taint.private && readOnlyFrom(taint, host) && !addressAsks(url, call, taint)) return false;
    return { why: host ? `reaches ${host}` : "reaches the network" };
  }
  if (tool === "skills.run" || tool === "skills.test") return { why: "runs a skill's code, which can reach the network" };
  if (inFamily(tool, KOS_FAMILIES) || tool.startsWith("secrets.")) return { why: "changes KOS itself" };
  if (tool.startsWith("computer.") || tool.startsWith("chrome.")) return { why: "acts on your computer" };
  const mcp = /^mcp\.([^.]+)\./.exec(tool);
  if (mcp) return { why: beyondAutoByName(tool) === "may send or publish something others see" ? `sends through ${mcp[1]}` : `changes something through ${mcp[1]}` };
  return { why: "reaches outside the workspace" };
}

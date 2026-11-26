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

  constructor(from: readonly TaintSource[] = []) {
    for (const source of from) this.mark(source);
  }

  /** Mark the turn as having read this. The same source once; past the cap, still tainted. */
  mark(source: TaintSource): void {
    if (this.read.length >= TAINT_SOURCES_MAX) return;
    const [kept] = keptSources([source]);
    if (kept && !this.read.some((s) => sameSource(s, kept))) this.read.push(kept);
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

/** What the guard knows of a call beside its arguments, for judging it in a tainted turn. */
export interface TaintedCall {
  tool: string;
  input: Record<string, unknown>;
  assessment: RiskAssessment;
  /** The call names a secret. */
  secret: boolean;
  /** The host of the caller's browser tab, for a browser call. */
  site?: string;
  /** The owner's own words this turn, when it began from them: a site they named is theirs to go to. */
  said?: string;
}

/** Why, in a tainted turn, a risky call asks though a saved yes would cover it; `auto` when Auto still may, its run being held offline. */
export interface TaintBar {
  why: string;
  auto?: true;
}

/** KOS's own tools whose risky calls stay inside the workspace, whatever the turn read: taint is carried, not stopped, by them. */
const LOCAL_FAMILIES = ["files.", "artifacts.", "tasks.", "memory.", "context.", "search.", "chats.", "export.", "tex."];

/** KOS's own families that change what KOS is, runs, or who may reach it. */
const KOS_FAMILIES = ["skills.", "modules.", "daemons.", "cron.", "blobs.", "systems.", "sites.", "builds.", "kos.", "improve.", "permissions."];

/** Discord tools that change the server's layout or who may see it, beside the posts. */
const DISCORD_CHANGES = new Set(["discord.audience", "discord.access", "discord.role", "discord.bind", "discord.make", "discord.sync", "discord.prune", "discord.listen"]);

/** Programs that run with the network unless Auto ran them, which holds them offline (shell.ts autoJail). */
const PROGRAMS = new Set(["shell.run", "python.run"]);

/** The words a tainted turn's ask adds to its reason. */
export const TAINT_REASON = "the turn read text you did not write first, so no saved yes covers it";

function inFamily(tool: string, families: readonly string[]): boolean {
  return families.some((f) => (f.endsWith(".") ? tool.startsWith(f) : tool === f || tool.startsWith(`${f}.`)));
}

/** The site of a host, as a turn's reads are counted: its registrable domain. */
function siteOf(host: string): string {
  return registrableDomain(host.toLowerCase());
}

/** Whether the owner's words name this site: its domain, or its name alone ("walmart" for www.walmart.com) as a word of three letters or more. */
export function namedBy(said: string | undefined, host: string): boolean {
  if (!said) return false;
  const site = siteOf(host);
  const words = said.toLowerCase();
  if (words.includes(site)) return true;
  const name = site.split(".")[0] ?? "";
  return name.length >= 3 && new RegExp(`(^|[^a-z0-9-])${name.replace(/[^a-z0-9-]/g, "")}([^a-z0-9-]|$)`).test(words);
}

/** Whether everything the turn read is pages of this host's site: what it does there next is the reading going on. */
function readOnlyFrom(taint: Taint, host: string): boolean {
  const site = siteOf(host);
  return taint.sources.every((s) => s.kind === "page" && s.where !== undefined && /^[a-z0-9.-]+$/i.test(s.where) && siteOf(s.where) === site);
}

/** The hosts a browser call would open that the turn has not been on and the owner did not name. */
export function newHosts(call: Pick<TaintedCall, "input" | "site" | "said">, taint: Taint): string[] {
  const known = new Set(taint.sites());
  if (call.site) known.add(siteOf(call.site));
  const hosts = addressesIn(call.input).flatMap((url) => {
    const host = hostOf(url) ?? hostOf(`https://${url}`);
    return host ? [host] : [];
  });
  return [...new Set(hosts.filter((h) => !known.has(siteOf(h)) && !namedBy(call.said, h)))];
}

/**
 * Why a call the risk rules let run unasked asks in a tainted turn, or
 * false. Only what reaches somewhere new or sets up work for later: a
 * browser step opening a site the turn has not been on, a schedule, a
 * standing helper. A post the owner alone reads stays unasked.
 */
export function taintRaises(call: Pick<TaintedCall, "tool" | "input" | "site" | "said">, taint: Taint): string | false {
  if (!taint.tainted) return false;
  const { tool } = call;
  if (tool.startsWith("browser.") || /^mcp\.[^.]*browser/.test(tool)) {
    const fresh = newHosts(call, taint);
    if (fresh.length) return `opens ${fresh.join(", ")}, a site this turn had not been on`;
  }
  if (tool === "cron.schedule") return "schedules work that runs later without you";
  if (tool === "blobs.create") return "sets up a standing helper";
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
  if (tool === "sql") {
    const sql = typeof input["sql"] === "string" ? input["sql"] : "";
    return writtenTables(codeOf(sql)).some(isKernelTable) || assessment.reason === "writes KOS's own tables" ? { why: "changes KOS's own tables" } : false;
  }
  if (inFamily(tool, LOCAL_FAMILIES)) return false;
  if (tool.startsWith("browser.")) {
    const fresh = newHosts(call, taint);
    if (fresh.length) return { why: `opens ${fresh.join(", ")}` };
    // Acting on the page the turn has been reading is browsing; a step there after reading anything else is not.
    return call.site && readOnlyFrom(taint, call.site) ? false : { why: "acts on a page after reading text from elsewhere" };
  }
  if (PROGRAMS.has(tool)) return { why: "runs a program that can reach the network", auto: true };
  if (tool === "notify" || tool.startsWith("discord.")) return { why: DISCORD_CHANGES.has(tool) ? "changes who sees what on the server" : "posts where others read" };
  if (tool === "http.fetch") {
    const host = typeof input["url"] === "string" ? hostOf(input["url"]) : undefined;
    // Reading on from the one site the turn has read (an API's next page) is reading; sending anything, or reaching anywhere else, is not.
    const method = String(input["method"] ?? "GET").toUpperCase();
    const reads = (method === "GET" || method === "HEAD") && (input["body"] === undefined || input["body"] === null || input["body"] === "");
    if (host && reads && readOnlyFrom(taint, host)) return false;
    return { why: host ? `reaches ${host}` : "reaches the network" };
  }
  if (tool === "skills.run" || tool === "skills.test") return { why: "runs a skill's code, which can reach the network" };
  if (inFamily(tool, KOS_FAMILIES) || tool.startsWith("secrets.")) return { why: "changes KOS itself" };
  if (tool.startsWith("computer.") || tool.startsWith("chrome.")) return { why: "acts on your computer" };
  const mcp = /^mcp\.([^.]+)\./.exec(tool);
  if (mcp) return { why: beyondAutoByName(tool) === "may send or publish something others see" ? `sends through ${mcp[1]}` : `changes something through ${mcp[1]}` };
  return { why: "reaches outside the workspace" };
}

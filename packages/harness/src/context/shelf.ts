import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ContentBlock, ModelMessage } from "../models/types.js";

/**
 * Big tool results, kept out of the way once they have been read.
 *
 * A page, a PDF or a long query read once was sent again with every later
 * message of the chat: tens of thousands of tokens re-read on each turn, for
 * a document the chat had finished with. Now a result over BIG_CHARS is kept
 * whole on disk under the workspace, stays whole in the chat for the turn it
 * came in and the next, and is then replaced by a stub: what it was, where it
 * came from, an outline written once, and a handle context.recall takes to
 * bring back a range or a search. Nothing is lost; it is one call away.
 *
 * The stub is written once and kept, so a chat's history changes at most
 * once per result, and every result that falls due at a turn's start is
 * stubbed together: the front of what is sent, which the provider's prompt
 * cache reuses, holds still between those turns.
 */

/** A result this long (about 8k tokens) is kept and later stubbed. */
export const BIG_CHARS = 32_000;
/** In one SDK query a result longer than this comes as its start, an outline and a handle. */
export const HUGE_CHARS = 64_000;
/** How much of a huge result comes in its first part. */
export const FIRST_CHUNK = 16_000;
/** The most a recall returns at once. */
const RECALL_MAX = 24_000;

const MARK = "[Kept as ";
const STUB = "[Set aside: ";

export interface Shelved {
  handle: string;
  tool: string;
  /** Where it came from, as a reader would say it: the path, the address, the query. */
  from: string;
  chars: number;
  at: number;
  outline?: string;
  /** The stub, frozen the first time it is shown. */
  stub?: string;
  text: string;
}

export type Outliner = (text: string, what: string) => Promise<string | undefined>;

/** Where a result came from, from the arguments the tool was given. */
export function fromOf(tool: string, input: Record<string, unknown>): string {
  for (const key of ["path", "url", "query", "q", "file", "name"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return tool;
}

export class ResultShelf {
  constructor(
    private readonly dir: string,
    private readonly outliner?: Outliner,
  ) {}

  private file(handle: string): string {
    return join(this.dir, `${handle}.json`);
  }

  private save(r: Shelved): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(r.handle), JSON.stringify(r));
  }

  get(handle: string): Shelved | undefined {
    if (!/^r_[a-z0-9]{8}$/.test(handle) || !existsSync(this.file(handle))) return undefined;
    return JSON.parse(readFileSync(this.file(handle), "utf8")) as Shelved;
  }

  /**
   * Keep a result. Big ones come back with a line naming their handle; a huge
   * one, when asked, comes back as its start, an outline and that line.
   */
  async keep(tool: string, input: Record<string, unknown>, text: string, opts: { huge?: boolean } = {}): Promise<string> {
    if (text.length <= BIG_CHARS) return text;
    const r: Shelved = { handle: `r_${randomBytes(4).toString("hex")}`, tool, from: fromOf(tool, input), chars: text.length, at: Date.now(), text };
    const cut = opts.huge === true && text.length > HUGE_CHARS;
    // A huge result is outlined at once, since the outline is what stands for the rest; others when they are stubbed.
    if (cut) r.outline = await this.outline(r);
    this.save(r);
    const line = `${MARK}${r.handle}: ${r.chars} characters from ${r.from}. When it is no longer in this chat, context.recall with handle "${r.handle}" brings back a range or a search.]`;
    if (!cut) return `${text}\n\n${line}`;
    return `${text.slice(0, FIRST_CHUNK)}\n\n[... ${r.chars - FIRST_CHUNK} more characters not shown. Outline of the whole: ${r.outline ?? "none yet"}]\n\n${line}`;
  }

  private async outline(r: Shelved): Promise<string | undefined> {
    if (!this.outliner) return undefined;
    try {
      return (await this.outliner(r.text, `${r.tool} result from ${r.from}`))?.trim().slice(0, 1200);
    } catch {
      return undefined;
    }
  }

  /** The stub that stands for a result once it is set aside, written once. */
  async stub(handle: string): Promise<string | undefined> {
    const r = this.get(handle);
    if (!r) return undefined;
    if (r.stub) return r.stub;
    r.outline ??= (await this.outline(r)) ?? r.text.slice(0, 600).replace(/\s+/g, " ");
    r.stub = `${STUB}the ${r.tool} result from ${r.from} (${r.chars} characters, handle ${r.handle}). Outline: ${r.outline} It is no longer in this chat: context.recall with handle "${r.handle}" and a search or a range brings back what you need.]`;
    this.save(r);
    return r.stub;
  }

  /** Part of a kept result again: the passages around a search, or a range of characters. */
  recall(handle: string, opts: { search?: string; from?: number; to?: number }): string {
    const r = this.get(handle);
    if (!r) return `no kept result ${handle}`;
    const search = opts.search?.trim();
    if (search) {
      const words = search.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const lower = r.text.toLowerCase();
      const hits: number[] = [];
      for (const w of words.length ? words : [search.toLowerCase()]) {
        for (let at = lower.indexOf(w); at !== -1 && hits.length < 40; at = lower.indexOf(w, at + w.length)) hits.push(at);
      }
      if (!hits.length) return `nothing in ${handle} matches "${search}"; ask for a range instead (it is ${r.chars} characters)`;
      // Windows around the hits, merged where they touch, best covered first.
      const windows = hits.sort((a, b) => a - b).map((h) => [Math.max(0, h - 700), Math.min(r.chars, h + 700)] as [number, number]);
      const merged: [number, number][] = [];
      for (const w of windows) {
        const last = merged.at(-1);
        if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
        else merged.push([...w]);
      }
      let out = "";
      for (const [a, b] of merged) {
        if (out.length > RECALL_MAX) break;
        out += `[characters ${a} to ${b}]\n${r.text.slice(a, b)}\n\n`;
      }
      return out.trim();
    }
    const from = Math.max(0, Math.floor(opts.from ?? 0));
    const to = Math.min(r.chars, Math.floor(opts.to ?? from + RECALL_MAX), from + RECALL_MAX);
    return `[characters ${from} to ${to} of ${r.chars}]\n${r.text.slice(from, to)}`;
  }
}

/** The handle a kept result carries, if it is one. */
export function handleIn(content: string): string | undefined {
  return /\[Kept as (r_[a-z0-9]{8}):/.exec(content)?.[1];
}

/** Whether a tool result is a kept one or its stub, which a reader of the chat should see. */
export function isShelved(content: string): boolean {
  return content.includes(MARK) || content.startsWith(STUB);
}

/** An owner's own words, which mark where one turn ends and the next begins. */
function ownerTurn(m: ModelMessage): boolean {
  return m.role === "user" && m.content.some((b) => b.type === "text" || b.type === "file");
}

/**
 * The history with every kept result older than the last turn set aside.
 *
 * A result stays whole in the turn it came in (its last owner message is the
 * latest in the history) and the next, the one being answered now; once
 * another owner message follows it, it is a stub. All that fall due are
 * stubbed at once, at the turn's start.
 */
export async function shelveHistory(history: ModelMessage[], shelf: ResultShelf): Promise<ModelMessage[]> {
  let owners = 0;
  const out = [...history];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (ownerTurn(m)) owners += 1;
    if (owners < 1 || !m.content.some((b) => b.type === "tool_result")) continue;
    let changed = false;
    const content: ContentBlock[] = [];
    for (const b of m.content) {
      const handle = b.type === "tool_result" ? handleIn(b.content) : undefined;
      const stub = handle ? await shelf.stub(handle) : undefined;
      if (b.type === "tool_result" && stub) {
        content.push({ ...b, content: stub });
        changed = true;
      } else content.push(b);
    }
    if (changed) out[i] = { ...m, content };
  }
  return out;
}

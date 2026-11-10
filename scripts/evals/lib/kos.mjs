// Talking to a scratch KOS as its owner would: chats, turns, approvals, and what it recorded.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a decided chat may go without being seen to resume before the run stops waiting on it. */
const RESUME_GRACE_MS = 30_000;

export class Kos {
  /** @param {import("./host.mjs").Host} host */
  constructor(host, log) {
    this.host = host;
    this.url = host.url;
    this.log = log;
    /** The chats this run opened; approvals are answered for these alone. */
    this.mine = new Set();
    /** Every approval this run saw and what the policy did with it. */
    this.approvals = [];
    /**
     * Who decides an approval: "approve" (default), "deny", or a function of the approval
     * returning "approve" | "deny" | "leave".
     */
    this.policy = "approve";
    /** When this run began: approvals filed with no chat after it are this run's. */
    this.since = Date.now();
    /**
     * Chats whose approval this run decided, until the turn the decision resumed is seen to
     * have run. A chat waiting on the owner is not working, so without this a run took the
     * "waiting on you" message for the answer and stopped before the resumed turn ran. Each
     * keeps where the chat stood once decided: its reply count and when it last changed.
     */
    this.resuming = new Map();
  }

  async api(path, body, ms = 20_000) {
    const r = await fetch(`${this.url}${path}`, { signal: AbortSignal.timeout(ms), ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return { error: text.slice(0, 200), status: r.status };
    }
  }

  async newChat(title, projectSlug) {
    const c = await this.api("/api/conversations/new", { title, ...(projectSlug ? { projectSlug } : {}) });
    this.mine.add(c.id);
    return c.id;
  }

  async conversations() {
    const list = await this.api("/api/conversations").catch(() => []);
    return Array.isArray(list) ? list : [];
  }

  async messages(id) {
    const got = await this.api(`/api/conversations/${encodeURIComponent(id)}/messages`).catch(() => ({}));
    return got.messages ?? [];
  }

  async replies(id) {
    return (await this.messages(id)).filter((m) => m.role === "kos").map((m) => m.text);
  }

  /** Answers the pending approvals of this run's chats, by the policy. */
  async decide() {
    const pending = await this.api("/api/approvals").catch(() => []);
    for (const a of Array.isArray(pending) ? pending : []) {
      // This run's chats, a project's chat it handed work to, or an approval filed with no chat while this run was going (the owner sees those in the inbox).
      const ours = this.mine.has(a.conversationId) || String(a.conversationId ?? "").startsWith("project:") || (!a.conversationId && (a.requestedAt ?? 0) >= (this.since ?? 0));
      if (!ours) continue;
      if (this.approvals.some((x) => x.id === a.id)) continue;
      const choice = typeof this.policy === "function" ? this.policy(a) : this.policy;
      this.approvals.push({ id: a.id, tool: a.tool, args: a.args, conversationId: a.conversationId, choice, at: Date.now() });
      if (choice === "approve") await this.api("/api/approve", { id: a.id }).catch(() => undefined);
      if (choice === "deny") await this.api("/api/deny", { id: a.id }).catch(() => undefined);
      if ((choice === "approve" || choice === "deny") && a.conversationId) await this.decided(a.conversationId);
    }
  }

  /** Where a decided chat stands, to tell its resumed turn by: a turn too quick to be seen working still moves it. */
  async decided(id) {
    const listed = (await this.conversations()).find((c) => c.id === id);
    this.resuming.set(id, { at: Date.now(), working: false, replies: (await this.replies(id)).length, updatedAt: listed?.updatedAt });
  }

  /**
   * Whether every turn a decision resumed has run, by the chats as listed now: seen working
   * since the decision, or moved on from where it stood (a reply more, or changed since), and
   * not working any more (asked again counts, and is decided anew); or never seen to resume
   * within the grace.
   */
  async resumed(list) {
    for (const [id, r] of this.resuming) {
      const c = list.find((x) => x.id === id);
      if (c?.activity === "working") {
        r.working = true;
        continue;
      }
      const moved = r.working || (c?.updatedAt ?? 0) > (r.updatedAt ?? Infinity) || (await this.replies(id)).length > r.replies;
      if (moved || Date.now() - r.at > RESUME_GRACE_MS) this.resuming.delete(id);
    }
    return this.resuming.size === 0;
  }

  /**
   * Says something in a chat as the owner and waits until a new reply has landed and the chat
   * is idle. Polls; no request outlives 20 seconds. The orchestrator is reached by its route.
   */
  async turn(chat, text, { limitMs = 600_000, orchestrator = false } = {}) {
    const id = orchestrator ? await this.orchestratorId() : chat;
    if (orchestrator) this.mine.add(id);
    const before = (await this.replies(id)).length;
    const t0 = Date.now();
    void (orchestrator ? this.api("/api/orchestrator", { text }, limitMs) : this.api("/api/message", { sessionId: id, text }, limitMs)).catch(() => undefined);
    let answer = "";
    let timedOut = true;
    let quiet = 0;
    while (Date.now() - t0 < limitMs) {
      await this.decide();
      const list = await this.conversations();
      const c = list.find((x) => x.id === id);
      const now = await this.replies(id);
      if ((await this.resumed(list)) && now.length > before && c?.activity !== "working") {
        // Twice in a row idle, so a turn that hands on to another step is not cut off between them.
        if (++quiet >= 2) {
          answer = now.slice(before).join("\n\n");
          timedOut = false;
          break;
        }
      } else quiet = 0;
      await sleep(700);
    }
    // Work handed on (a handoff, a dispatch to a project's chat) runs in other chats: wait for those too.
    await this.settle(t0 + limitMs);
    const after = await this.replies(id);
    if (after.length > before) answer = after.slice(before).join("\n\n");
    return { chat: id, t0, t1: Date.now(), wall: (Date.now() - t0) / 1000, answer, timedOut };
  }

  /** Until no chat on the host is working and every decided one has resumed and ended (three quiet looks in a row), or the deadline. */
  async settle(deadline) {
    let quiet = 0;
    while (Date.now() < deadline && quiet < 3) {
      await this.decide();
      const list = await this.conversations();
      const busy = list.filter((c) => c.activity === "working");
      for (const c of busy) this.mine.add(c.id);
      quiet = (await this.resumed(list)) && !busy.length ? quiet + 1 : 0;
      await sleep(1000);
    }
  }

  /** KOS at the root: the orchestrator's thread, by the kernel's naming. */
  async orchestratorId() {
    return "orchestrator:owner";
  }

  /** Tool calls KOS recorded since a moment, oldest first (the audit log). */
  toolCalls(since) {
    return this.host.sql(`select id, tool, args, substr(result, 1, 4000) as result, is_error as isError, created_at as at from audit_log where created_at >= ${Math.floor(since)} order by id`);
  }

  /** Tokens and cost KOS recorded since a moment (token_usage). */
  usage(since) {
    const [u] = this.host.sql(`select coalesce(sum(input_tokens),0) as input, coalesce(sum(output_tokens),0) as output, coalesce(sum(cache_read_tokens),0) as cached, coalesce(sum(cache_creation_tokens),0) as written, coalesce(sum(cost_usd),0) as cost from token_usage where at >= ${Math.floor(since)}`);
    return u;
  }
}

/**
 * Every model call the Claude Agent SDK made for a workspace between two moments, from its own
 * log: when it was asked, how long the model took, the tool time to the next call, the tokens.
 */
export function sdkCalls(workspace, t0, t1) {
  const dir = join(homedir(), ".claude", "projects", resolve(workspace).replace(/[^A-Za-z0-9]/g, "-"));
  if (!existsSync(dir)) return [];
  const lines = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".jsonl") && statSync(p).mtimeMs >= t0) {
        for (const raw of readFileSync(p, "utf8").split("\n")) {
          if (!raw.trim()) continue;
          try {
            const j = JSON.parse(raw);
            const at = Date.parse(j.timestamp ?? "");
            if (at >= t0 - 1000 && at <= t1 + 2000) lines.push({ ...j, at });
          } catch {
            /* a line still being written */
          }
        }
      }
    }
  };
  walk(dir);
  lines.sort((a, b) => a.at - b.at);
  const calls = new Map();
  let lastInput = t0;
  for (const l of lines) {
    if (l.type === "assistant" && l.message?.id) {
      const u = l.message.usage ?? {};
      const prev = calls.get(l.message.id);
      calls.set(l.message.id, {
        model: l.message.model,
        sidechain: l.isSidechain === true,
        asked: prev?.asked ?? lastInput,
        answered: l.at,
        input: u.input_tokens ?? 0,
        cached: u.cache_read_input_tokens ?? 0,
        written: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        tools: [...(prev?.tools ?? []), ...(l.message.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name.replace(/^mcp__kos__/, ""))],
      });
    } else if (l.type === "user") lastInput = l.at;
  }
  const out = [...calls.values()].sort((a, b) => a.asked - b.asked);
  return out.map((c, i) => ({ ...c, modelMs: c.answered - c.asked, toolMs: i + 1 < out.length ? Math.max(0, out[i + 1].asked - c.answered) : 0 }));
}

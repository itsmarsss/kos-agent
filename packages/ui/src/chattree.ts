import type { Conversation } from "./api.js";
import type { Route } from "./routes.js";

/**
 * The shape of the conversation list.
 *
 * KOS routes work to project chats, and a project chat spawns conversations
 * for the work: a three-level tree. The store keeps it flat, each conversation
 * stamped with its project, and the list used to show it flat too, so an
 * agent a project made sat beside the chats you began with nothing saying
 * whose it was. This groups them back under their project.
 */

const BUSY = new Set(["working", "needs-you"]);

export function isBusy(c: Conversation): boolean {
  return c.activity !== undefined && BUSY.has(c.activity);
}

/** Busy first, then newest first: the one you want is the one doing something. */
export function byAttention(a: Conversation, b: Conversation): number {
  const ab = isBusy(a);
  const bb = isBusy(b);
  if (ab !== bb) return ab ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

export interface ChatTree {
  /** Chats with no project: yours, at the root. */
  roots: Conversation[];
  /** A project's agents, keyed by slug. */
  byProject: Map<string, Conversation[]>;
}

export function groupChats(conversations: Conversation[]): ChatTree {
  const roots: Conversation[] = [];
  const byProject = new Map<string, Conversation[]>();
  for (const c of conversations) {
    if (c.kind !== "chat") continue;
    if (c.projectSlug) {
      const list = byProject.get(c.projectSlug) ?? [];
      list.push(c);
      byProject.set(c.projectSlug, list);
    } else {
      roots.push(c);
    }
  }
  for (const list of byProject.values()) list.sort(byAttention);
  return { roots, byProject };
}

/**
 * Where a conversation opens.
 *
 * A project's threads, its orchestrator and the agents under it, open inside
 * the project, beside its files and the rest of its agents; everything else
 * opens in Chats. An orchestrator just made is not in the list yet, but its
 * id names its project, so that is enough to place it.
 */
export function placeOf(id: string, c?: Conversation): Route {
  if (c?.kind === "project" && c.projectSlug) return { name: "project", slug: c.projectSlug };
  if (c?.kind === "chat" && c.projectSlug) return { name: "project", slug: c.projectSlug, id };
  if (!c && id.startsWith("project:")) return { name: "project", slug: id.slice("project:".length) };
  return { name: "chats", id };
}

/** One line under a project row: how many agents, and whether any is busy. */
export function projectSummary(agents: Conversation[]): string {
  if (agents.length === 0) return "No agents yet";
  const busy = agents.filter(isBusy).length;
  const n = `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
  return busy > 0 ? `${n} · ${busy} working` : n;
}

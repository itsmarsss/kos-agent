import { describe, expect, it } from "vitest";

import type { Conversation } from "./api.js";
import { groupChats, placeOf, projectSummary } from "./chattree.js";

function convo(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    userId: "owner",
    title: id,
    channel: null,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    brief: null,
    toolAllow: null,
    projectSlug: null,
    kind: "chat",
    ...over,
  };
}

describe("the conversation tree", () => {
  it("puts a project's agents under the project and the rest at the root", () => {
    const tree = groupChats([
      convo("mine"),
      convo("project:pantry", { kind: "project", projectSlug: "pantry" }),
      convo("shelves", { projectSlug: "pantry" }),
      convo("kos", { kind: "orchestrator" }),
    ]);
    expect(tree.roots.map((c) => c.id)).toEqual(["mine"]);
    expect(tree.byProject.get("pantry")?.map((c) => c.id)).toEqual(["shelves"]);
  });

  it("keeps a blob's work for a project out of the project's list, and opens it on the blob's page", () => {
    const asked = convo("cmwtr85gv2:owner", { projectSlug: "interview_prep", role: "follow-ups", title: "Follow ups" });
    const tree = groupChats([asked, convo("mock", { projectSlug: "interview_prep" })]);
    expect(tree.byProject.get("interview_prep")?.map((c) => c.id)).toEqual(["mock"]);
    expect(tree.roots).toEqual([]);
    expect(placeOf(asked.id, asked)).toEqual({ name: "blobs", blob: "follow-ups", id: asked.id });
  });

  it("lists the busy agents first, then the newest", () => {
    const tree = groupChats([
      convo("old", { projectSlug: "p", updatedAt: 1 }),
      convo("new", { projectSlug: "p", updatedAt: 9 }),
      convo("busy", { projectSlug: "p", updatedAt: 2, activity: "working" }),
    ]);
    expect(tree.byProject.get("p")?.map((c) => c.id)).toEqual(["busy", "new", "old"]);
  });

  it("opens a project's threads inside the project and the rest in Chats", () => {
    expect(placeOf("project:pantry", convo("project:pantry", { kind: "project", projectSlug: "pantry" }))).toEqual({
      name: "project",
      slug: "pantry",
    });
    expect(placeOf("shelves", convo("shelves", { projectSlug: "pantry" }))).toEqual({
      name: "project",
      slug: "pantry",
      id: "shelves",
    });
    // Just made, so not in the list yet: the id still says whose it is.
    expect(placeOf("project:pantry")).toEqual({ name: "project", slug: "pantry" });
    expect(placeOf("mine", convo("mine"))).toEqual({ name: "chats", id: "mine" });
    // A standing agent's thread lives on the agent's page, not in Chats.
    expect(placeOf("agent:research", convo("agent:research", { kind: "agent", role: "research" }))).toEqual({ name: "blobs", blob: "research" });
    expect(placeOf("agent:research")).toEqual({ name: "blobs", blob: "research" });
    expect(placeOf("kos", convo("kos", { kind: "orchestrator" }))).toEqual({ name: "chats", id: "kos" });
    expect(placeOf("gone")).toEqual({ name: "chats", id: "gone" });
  });

  it("sums a project up in a line", () => {
    expect(projectSummary([])).toBe("No agents yet");
    expect(projectSummary([convo("a")])).toBe("1 agent");
    expect(projectSummary([convo("a"), convo("b", { activity: "needs-you" })])).toBe("2 agents · 1 working");
  });
});

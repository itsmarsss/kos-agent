import { describe, expect, it } from "vitest";

import type { Conversation } from "./api.js";
import { groupChats, projectSummary } from "./chattree.js";

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

  it("lists the busy agents first, then the newest", () => {
    const tree = groupChats([
      convo("old", { projectSlug: "p", updatedAt: 1 }),
      convo("new", { projectSlug: "p", updatedAt: 9 }),
      convo("busy", { projectSlug: "p", updatedAt: 2, activity: "working" }),
    ]);
    expect(tree.byProject.get("p")?.map((c) => c.id)).toEqual(["busy", "new", "old"]);
  });

  it("sums a project up in a line", () => {
    expect(projectSummary([])).toBe("No agents yet");
    expect(projectSummary([convo("a")])).toBe("1 agent");
    expect(projectSummary([convo("a"), convo("b", { activity: "needs-you" })])).toBe("2 agents · 1 working");
  });
});

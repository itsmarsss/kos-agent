import { describe, expect, it } from "vitest";

import { hrefFor, NAV, navActive, parseRoute } from "./routes.js";

describe("parseRoute", () => {
  it("round-trips every nav destination", () => {
    for (const item of NAV) {
      expect(parseRoute(hrefFor(item.route))).toEqual(item.route);
    }
  });

  it("accepts the label a reader actually sees in the nav", () => {
    // The tabs read Knowledge, Schedule and Activity; the routes were named
    // after their tables, so those URLs silently rendered Home.
    expect(parseRoute("#/knowledge")).toEqual({ name: "memory" });
    // A settings section is a place you can be sent to, so it has a hash.
    expect(parseRoute("#/settings/modules")).toEqual({ name: "settings", section: "modules" });
    expect(hrefFor({ name: "settings", section: "modules" })).toBe("#/settings/modules");
    expect(parseRoute("#/schedule")).toEqual({ name: "crons" });
    expect(parseRoute("#/activity")).toEqual({ name: "history" });
    // Activity and Runs became one page. Their paths still resolve, because a
    // bookmark should not break when two pages merge.
    expect(parseRoute("#/runs")).toEqual({ name: "history" });
    expect(parseRoute("#/tools")).toEqual({ name: "history" });
    expect(parseRoute("#/history")).toEqual({ name: "history" });
  });

  it("opens on a conversation, with the overview and inbox as pages", () => {
    expect(parseRoute("#/")).toEqual({ name: "chats" });
    expect(parseRoute("")).toEqual({ name: "chats" });
    expect(parseRoute("#/home")).toEqual({ name: "home" });
    expect(hrefFor({ name: "home" })).toBe("#/home");
    expect(parseRoute("#/inbox")).toEqual({ name: "inbox" });
    // A page's own query does not change which page it is.
    expect(parseRoute("#/memory?tab=log")).toEqual({ name: "memory" });
  });

  it("lights the Runs entry for all three of its routes, and Projects for a page", () => {
    expect(navActive({ name: "history" }, { name: "crons" })).toBe(true);
    expect(navActive({ name: "history" }, { name: "agents", id: 3 })).toBe(true);
    expect(navActive({ name: "projects" }, { name: "page", id: "x" })).toBe(true);
    // A project's workspace is a place inside Projects, like one of its pages.
    expect(navActive({ name: "projects" }, { name: "project", slug: "x" })).toBe(true);
    expect(navActive({ name: "chats" }, { name: "inbox" })).toBe(false);
  });

  it("opens one project's workspace by slug", () => {
    expect(parseRoute("#/project/kitchen_redo")).toEqual({ name: "project", slug: "kitchen_redo" });
    expect(hrefFor({ name: "project", slug: "kitchen_redo" })).toBe("#/project/kitchen_redo");
    expect(parseRoute(hrefFor({ name: "project", slug: "a b/c" }))).toEqual({ name: "project", slug: "a b/c" });
    // A thread inside the project: an agent's, or the orchestrator's by default.
    expect(parseRoute("#/project/kitchen_redo/c9%3Aowner")).toEqual({
      name: "project",
      slug: "kitchen_redo",
      id: "c9:owner",
    });
    expect(hrefFor({ name: "project", slug: "kitchen_redo", id: "c9:owner" })).toBe("#/project/kitchen_redo/c9%3Aowner");
    // The list and a workspace are different routes; a bare /project is neither.
    expect(parseRoute("#/project")).toEqual({ name: "home" });
  });

  it("keeps ids and paths through a round trip", () => {
    expect(parseRoute(hrefFor({ name: "chats", id: "primary:owner" }))).toEqual({
      name: "chats",
      id: "primary:owner",
    });
    expect(parseRoute(hrefFor({ name: "files", path: "notes/a b.md" }))).toEqual({
      name: "files",
      path: "notes/a b.md",
    });
    expect(parseRoute(hrefFor({ name: "page", id: "monthly_expense" }))).toEqual({
      name: "page",
      id: "monthly_expense",
    });
  });
});

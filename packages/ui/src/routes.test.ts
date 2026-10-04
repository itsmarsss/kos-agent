import { describe, expect, it } from "vitest";

import { hrefFor, NAV, parseRoute } from "./routes.js";

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

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
    expect(parseRoute("#/schedule")).toEqual({ name: "crons" });
    expect(parseRoute("#/activity")).toEqual({ name: "tools" });
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

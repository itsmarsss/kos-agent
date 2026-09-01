import { describe, expect, it, vi } from "vitest";

import { buildActions, fuzzyScore, parseQuery, type PaletteContext } from "./CommandPalette.js";

describe("what the palette does with what you type", () => {
  describe("operators", () => {
    it("reads a kind prefix, the same ones the @ menu uses", () => {
      expect(parseQuery("file:budget")).toEqual({
        kind: "file",
        term: "budget",
        actionsOnly: false,
      });
      expect(parseQuery("project:")).toEqual({
        kind: "project",
        term: "",
        actionsOnly: false,
      });
    });

    it("treats > as commands only", () => {
      expect(parseQuery("> snap")).toEqual({ term: "snap", actionsOnly: true });
    });

    /*
     * A colon is ordinary in a filename and a chat title, so only a real kind
     * counts as an operator. Otherwise typing a name with a colon in it would
     * silently search for nothing.
     */
    it("leaves a colon that is not an operator alone", () => {
      expect(parseQuery("notes: monday")).toEqual({
        term: "notes: monday",
        actionsOnly: false,
      });
      expect(parseQuery("http://example.com")).toEqual({
        term: "http://example.com",
        actionsOnly: false,
      });
    });
  });

  describe("fuzzy matching", () => {
    it("puts an exact prefix first", () => {
      expect(fuzzyScore("Habit Tracker", "hab")).toBeGreaterThan(
        fuzzyScore("Rehabilitation", "hab"),
      );
    });

    it("matches letters spread through the text", () => {
      expect(fuzzyScore("Open workspace folder", "owf")).toBeGreaterThan(0);
      expect(fuzzyScore("Snapshot now", "owf")).toBe(0);
    });

    it("prefers a word boundary to the middle of a word", () => {
      expect(fuzzyScore("budget tracker", "tr")).toBeGreaterThan(
        fuzzyScore("subtraction", "tr"),
      );
    });

    it("prefers the shorter of two equally good matches", () => {
      expect(fuzzyScore("notes.md", "notes")).toBeGreaterThan(
        fuzzyScore("notes-from-last-quarter.md", "notes"),
      );
    });

    it("matches everything when nothing is typed", () => {
      expect(fuzzyScore("anything", "")).toBeGreaterThan(0);
    });
  });

  describe("actions", () => {
    const ctx = (): PaletteContext => ({
      go: vi.fn(),
      openChat: vi.fn(),
      openSettings: vi.fn(),
      newChat: vi.fn(),
      openWorkspace: vi.fn(),
      snapshot: vi.fn(),
      refresh: vi.fn(),
      sitesBase: null,
    });

    it("offers the things the owner reaches for", () => {
      const labels = buildActions(ctx()).map((a) => a.label);
      expect(labels).toContain("Open KOS");
      expect(labels).toContain("New chat");
      expect(labels).toContain("Settings");
      expect(labels).toContain("Open workspace folder");
    });

    /*
     * Built from NAV rather than listed again, so a page added to the nav is
     * reachable from the palette without anyone remembering to add it.
     */
    it("can go to every page in the nav", () => {
      const labels = buildActions(ctx()).map((a) => a.label);
      for (const page of ["Home", "Chats", "Files", "Projects", "Schedule"]) {
        expect(labels, `no way to reach ${page}`).toContain(`Go to ${page}`);
      }
    });

    it("runs the action it was given", () => {
      const c = ctx();
      buildActions(c).find((a) => a.label === "Open KOS")?.run();
      expect(c.openChat).toHaveBeenCalledWith("orchestrator");
    });

    it("finds an action by what it does, not only by its name", () => {
      const actions = buildActions(ctx());
      const settings = actions.find((a) => a.label === "Settings");
      // "api key" is why you would go to Settings, and is not in its label.
      expect(fuzzyScore(settings?.keywords ?? "", "api key")).toBeGreaterThan(0);
    });
  });
});

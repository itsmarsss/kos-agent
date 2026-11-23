// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchHit, SearchKind, SearchResults } from "@kos/shared";

import { api } from "./api.js";
import {
  buildActions,
  clusterByGroup,
  CommandPalette,
  everywhereRows,
  fullTextKinds,
  fuzzyScore,
  parseQuery,
  searchesNames,
  settingsHits,
  type PaletteContext,
} from "./CommandPalette.js";
import { targetHref } from "./hashparams.js";

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
      openAgent: vi.fn(),
      sitesBase: null,
      openTarget: vi.fn(),
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
      for (const page of ["Overview", "Chats", "Inbox", "Files", "Projects", "Schedule", "Runs"]) {
        expect(labels, `no way to reach ${page}`).toContain(`Go to ${page}`);
      }
    });

    it("offers each page's create, the theme, the quick question, the browser and the keys", () => {
      const c: PaletteContext = { ...ctx(), quickAsk: vi.fn(), openBrowser: vi.fn(), setTheme: vi.fn(), showKeys: vi.fn() };
      const actions = buildActions(c);
      const labels = actions.map((a) => a.label);
      for (const want of ["New project", "New schedule", "New claim", "Quick ask", "KOS's browser", "Theme: Light", "Theme: Dark", "Keyboard shortcuts"]) expect(labels).toContain(want);
      // A create goes to its page with `new` on the address, which the page opens its sheet for.
      actions.find((a) => a.label === "New schedule")!.run();
      expect(window.location.hash).toBe("#/schedule?new=1");
      actions.find((a) => a.label === "Theme: Light")!.run();
      expect(c.setTheme).toHaveBeenCalledWith("light");
      // "new project" is found by its words.
      expect(fuzzyScore(actions.find((a) => a.id === "new-project")!.label, "new project")).toBeGreaterThan(0);
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

  it("shows each group once, where its best result was", () => {
    const out = clusterByGroup([
      { id: 1, group: "Chats" },
      { id: 2, group: "Projects" },
      { id: 3, group: "Chats" },
      { id: 4, group: "Schedule" },
    ]);
    expect(out.map((x) => x.id)).toEqual([1, 3, 2, 4]);
  });
});

const hit = (kind: SearchHit["kind"], id: string, score: number, over: Partial<SearchHit> = {}): SearchHit => ({
  kind,
  id,
  title: id,
  snippet: { text: `the ${id} line`, marks: [[4, 4 + id.length]] },
  score,
  target: { kind: "chat", id, event: 0 },
  ...over,
});

describe("what Everywhere searches", () => {
  it("asks every source unnarrowed, one source by its prefix, and none for a name's prefix or one letter", () => {
    expect(fullTextKinds(parseQuery("marigold"))).toEqual(["msg", "text", "memory", "run", "secret"]);
    expect(fullTextKinds(parseQuery("msg: marigold"))).toEqual(["msg"]);
    expect(fullTextKinds(parseQuery("text:water"))).toEqual(["text"]);
    expect(fullTextKinds(parseQuery("file:plan"))).toEqual([]);
    expect(fullTextKinds(parseQuery("m"))).toEqual([]);
    expect(fullTextKinds(parseQuery("> snap"))).toEqual([]);
  });

  it("searches names except under a full-text prefix", () => {
    expect(searchesNames(parseQuery("plan"))).toBe(true);
    expect(searchesNames(parseQuery("file:plan"))).toBe(true);
    for (const q of ["msg:plan", "secret:plan", "settings:theme", "> x"]) expect(searchesNames(parseQuery(q)), q).toBe(false);
  });

  it("finds settings by their words everywhere, by their letters under settings:", () => {
    expect(settingsHits(parseQuery("timezone"))[0]).toMatchObject({ kind: "settings", title: "Timezone", hint: "You", target: { kind: "settings", section: "you" } });
    expect(settingsHits(parseQuery("tmzn"))).toEqual([]);
    expect(settingsHits(parseQuery("settings:tmzn"))[0]?.title).toBe("Timezone");
    expect(settingsHits(parseQuery("settings:")).map((h) => h.target)).toContainEqual({ kind: "settings", section: "network" });
    expect(settingsHits(parseQuery("msg:timezone"))).toEqual([]);
  });

  it("ranks hits across sources, words a run's call, and marks a name in place of a snippet", () => {
    const rows = everywhereRows(
      [
        hit("msg", "low", 0.5, { hint: "you" }),
        hit("secret", "Bank", 0.9, { snippet: { text: "Bank", marks: [[0, 4]] }, hint: "login", target: { kind: "secret", handle: "bank" } }),
        hit("run", "Write a file", 0.7, { hint: "Step", target: { kind: "call", id: 3 } }),
      ],
      vi.fn(),
    );
    expect(rows.map((r) => r.label)).toEqual(["Bank", "Write a file", "low"]);
    expect(rows.map((r) => r.hint)).toEqual(["Secret · login", "Step", "Message · you"]);
    expect(rows[0]).toMatchObject({ labelMarks: [[0, 4]] });
    expect(rows[0]!.snippet).toBeUndefined();
    expect(rows[2]!.snippet).toEqual({ text: "the low line", marks: [[4, 7]] });
    expect(new Set(rows.map((r) => r.group))).toEqual(new Set(["Everywhere"]));
  });

  it("opens each kind of hit at its place", () => {
    const place = (id: string): { name: "chats"; id: string } => ({ name: "chats", id });
    expect(targetHref({ kind: "chat", id: "c1", event: 4 }, place)).toBe("#/chats/c1?at=4");
    expect(targetHref({ kind: "file", path: "projects/a b.md", line: 9 }, place)).toBe("#/files/projects%2Fa%20b.md?line=9");
    expect(targetHref({ kind: "claim", id: 7 }, place)).toBe("#/memory?tab=claims&ids=7");
    expect(targetHref({ kind: "memory-page", name: "garden" }, place)).toBe("#/memory?tab=pages&page=garden");
    expect(targetHref({ kind: "secret", handle: "bank" }, place)).toBe("#/secrets?open=bank");
    expect(targetHref({ kind: "settings", section: "network" }, place)).toBe("#/settings/network");
    expect(targetHref({ kind: "run", id: 1 }, place)).toBeUndefined();
  });
});

describe("the palette", () => {
  // jsdom lays nothing out, so there is nothing to scroll.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const ctx = (): PaletteContext => ({
    go: vi.fn(),
    openChat: vi.fn(),
    openSettings: vi.fn(),
    newChat: vi.fn(),
    openWorkspace: vi.fn(),
    snapshot: vi.fn(),
    refresh: vi.fn(),
    openAgent: vi.fn(),
    sitesBase: null,
    openTarget: vi.fn(),
  });

  /** Each source answers when its promise is let go, so a test can say which arrive first. */
  function sources(): { release: (kind: SearchKind, hits: SearchHit[], late?: boolean) => void; asked: string[][] } {
    const waiting = new Map<SearchKind, (r: SearchResults) => void>();
    const asked: string[][] = [];
    vi.spyOn(api, "search").mockImplementation((_q, kinds = []) => {
      asked.push([...kinds]);
      return new Promise((resolve) => waiting.set(kinds[0]!, resolve));
    });
    return {
      asked,
      release: (kind, hits, late = false) => act(() => waiting.get(kind)?.({ hits, late: late ? [kind] : [], truncated: [] })),
    };
  }

  const typeIn = (text: string): void => {
    fireEvent.change(screen.getByRole("textbox", { name: /Search everything/ }), { target: { value: text } });
  };
  const rows = (): string[] => [...document.querySelectorAll(".pal-item .pal-label")].map((e) => e.textContent ?? "");
  const cursorRow = (): string => document.querySelector(".pal-item.is-cursor .pal-label")?.textContent ?? "";

  it("keeps names at once and fills Everywhere in as each source answers, the cursor where it was", async () => {
    vi.spyOn(api, "mentions").mockResolvedValue({ mentions: [{ kind: "project", id: "garden", label: "Marigold garden" }], commands: [] } as never);
    const { release, asked } = sources();
    const c = ctx();
    render(<CommandPalette open onClose={() => {}} ctx={c} />);
    typeIn("marigold");
    await waitFor(() => expect(rows()).toContain("Marigold garden"));
    await waitFor(() => expect(asked.length).toBe(5));
    expect(screen.getByRole("status").textContent).toBe("Searching chats, files, memory, runs and secrets…");

    release("msg", [hit("msg", "Garden chat", 0.8, { hint: "you" })]);
    await waitFor(() => expect(rows()).toEqual(["Marigold garden", "Garden chat"]));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });
    expect(cursorRow()).toBe("Garden chat");

    // A better hit arrives above it; the cursor stays on the row it was on.
    release("text", [hit("text", "projects/plan.md", 0.95, { hint: "line 3", target: { kind: "file", path: "projects/plan.md", line: 3 } })]);
    await waitFor(() => expect(rows()).toEqual(["Marigold garden", "projects/plan.md", "Garden chat"]));
    expect(cursorRow()).toBe("Garden chat");
    expect(document.querySelector(".pal-item.is-cursor .pal-snippet mark")?.textContent).toBe("Garden chat");
    expect(screen.getByRole("status").textContent).toBe("searching memory, runs and secrets…");

    release("memory", []);
    release("run", []);
    release("secret", [], true);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Secrets did not answer in time. Try again, or start with “secret:” to search only there."));

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(c.openTarget).toHaveBeenCalledWith({ kind: "file", path: "projects/plan.md", line: 3 });
  });

  it("narrows to one source by its prefix, without names, and says when nothing holds it", async () => {
    const mentions = vi.spyOn(api, "mentions").mockResolvedValue({ mentions: [], commands: [] } as never);
    const { release, asked } = sources();
    render(<CommandPalette open onClose={() => {}} ctx={ctx()} />);
    typeIn("msg:zinnia");
    await waitFor(() => expect(asked).toEqual([["msg"]]));
    // Only the list offered before anything was typed.
    expect(mentions.mock.calls.map((c) => c[0])).toEqual([""]);
    expect(screen.getByText("Searching chats…")).toBeTruthy();
    release("msg", []);
    await waitFor(() => expect(screen.getByText("Nothing matches.")).toBeTruthy());
  });

  it("draws a snippet's marks as elements, never its words as markup", async () => {
    vi.spyOn(api, "mentions").mockResolvedValue({ mentions: [], commands: [] } as never);
    const { release } = sources();
    render(<CommandPalette open onClose={() => {}} ctx={ctx()} />);
    typeIn("msg:img");
    await waitFor(() => expect(api.search).toHaveBeenCalled());
    release("msg", [hit("msg", "Chat", 0.9, { snippet: { text: '<img src=x onerror="boom">', marks: [[1, 4]] } })]);
    await waitFor(() => expect(document.querySelector(".pal-snippet")).toBeTruthy());
    expect(document.querySelector(".pal-snippet img")).toBeNull();
    expect(document.querySelector(".pal-snippet")?.textContent).toBe('<img src=x onerror="boom">');
    expect(document.querySelector(".pal-snippet mark")?.textContent).toBe("img");
  });
});

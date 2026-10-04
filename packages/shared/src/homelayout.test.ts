import { describe, expect, it } from "vitest";

import { DEFAULT_HOME, parseHomeLayout } from "./pagespec.js";

/**
 * Reading a stored home layout.
 *
 * This is owner-edited configuration that decides whether they have a home
 * page at all, so the failure to avoid is a bad value leaving them with a
 * blank screen and no way back.
 */
describe("the home layout", () => {
  it("keeps a layout it understands", () => {
    const layout = parseHomeLayout({
      panels: [{ id: "a", kind: "approvals", span: "full" }],
    });
    expect(layout.panels).toEqual([{ id: "a", kind: "approvals", span: "full" }]);
  });

  it("falls back to the default rather than leaving no home page", () => {
    for (const junk of [null, undefined, 42, "layout", {}, { panels: "no" }]) {
      expect(parseHomeLayout(junk), String(junk)).toEqual(DEFAULT_HOME);
    }
  });

  it("has a panel for memory and one for modules", () => {
    const layout = parseHomeLayout({ panels: [{ kind: "memory", span: "half" }, { kind: "modules", span: "half" }] });
    expect(layout.panels.map((p) => p.kind)).toEqual(["memory", "modules"]);
    expect(DEFAULT_HOME.panels.map((p) => p.kind)).toContain("memory");
  });

  it("drops a panel kind it does not have", () => {
    const layout = parseHomeLayout({
      panels: [{ kind: "nonsense" }, { kind: "spend", span: "half" }],
    });
    expect(layout.panels.map((p) => p.kind)).toEqual(["spend"]);
  });

  it("repairs a width it cannot use rather than refusing the panel", () => {
    const layout = parseHomeLayout({ panels: [{ kind: "spend", span: "gigantic" }] });
    expect(layout.panels[0]?.span).toBe("half");
  });

  /*
   * Two panels sharing an id makes them indistinguishable to the editor: a
   * move or a remove would hit whichever React happened to match first.
   */
  it("makes ids unique so the editor can tell panels apart", () => {
    const layout = parseHomeLayout({
      panels: [
        { id: "note", kind: "note" },
        { id: "note", kind: "note" },
        { id: "note", kind: "note" },
      ],
    });
    expect(new Set(layout.panels.map((p) => p.id)).size).toBe(3);
  });

  it("allows an empty layout, which the owner can reach deliberately", () => {
    expect(parseHomeLayout({ panels: [] })).toEqual({ panels: [] });
  });

  it("keeps a note's text and a list's limit", () => {
    const layout = parseHomeLayout({
      panels: [
        { kind: "note", text: "buy milk" },
        { kind: "activity", limit: 3 },
        { kind: "chats", limit: -5 },
      ],
    });
    expect(layout.panels[0]?.text).toBe("buy milk");
    expect(layout.panels[1]?.limit).toBe(3);
    // A negative limit would render nothing; treated as unset.
    expect(layout.panels[2]?.limit).toBeUndefined();
  });
});

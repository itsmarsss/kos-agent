import { describe, expect, it } from "vitest";

import { mentionRefusal, openRefusal, pickerPlace, type DocCallState } from "./docbridge.js";

const doc: DocCallState = { kind: "doc", locked: false, presenting: false, pressed: true };
const asking = { ...doc, editing: true, asking: false };
const at = { x: 120, y: 80 };

describe("a doc's kos.open", () => {
  it("opens an artifact by its id at the owner's press", () => {
    expect(openRefusal(doc, "q4-plan")).toBeUndefined();
  });

  it("is refused without a press, for a page or a deck, while presenting, and for an older version", () => {
    expect(openRefusal({ ...doc, pressed: false }, "q4-plan")).toMatch(/owner's press/);
    expect(openRefusal({ ...doc, kind: "page" }, "q4-plan")).toMatch(/only a doc/);
    expect(openRefusal({ ...doc, kind: "deck" }, "q4-plan")).toMatch(/only a doc/);
    expect(openRefusal({ ...doc, presenting: true }, "q4-plan")).toMatch(/presented/);
    expect(openRefusal({ ...doc, locked: true }, "q4-plan")).toMatch(/older version/);
  });

  it("refuses what is not an artifact's id, and one the owner has none of", () => {
    for (const bad of ["../settings", "#/chats", "", "1abc", "a b", 42, undefined, "x".repeat(121)]) expect(openRefusal(doc, bad), String(bad)).toMatch(/not an artifact's id/);
    expect(openRefusal(doc, "gone", (id) => id === "here")).toMatch(/no artifact/);
  });
});

describe("a doc's kos.mention", () => {
  it("opens the picker while the doc is edited, at the owner's press", () => {
    expect(mentionRefusal(asking, at)).toBeUndefined();
  });

  it("is refused without a press, for a page or a deck, while presenting or locked, outside editing, and with one already open", () => {
    expect(mentionRefusal({ ...asking, pressed: false }, at)).toMatch(/owner's press/);
    expect(mentionRefusal({ ...asking, kind: "page" }, at)).toMatch(/only a doc/);
    expect(mentionRefusal({ ...asking, kind: "deck" }, at)).toMatch(/only a doc/);
    expect(mentionRefusal({ ...asking, presenting: true }, at)).toMatch(/presented/);
    expect(mentionRefusal({ ...asking, locked: true }, at)).toMatch(/older version/);
    expect(mentionRefusal({ ...asking, editing: false }, at)).toMatch(/being edited/);
    expect(mentionRefusal({ ...asking, asking: true }, at)).toMatch(/already open/);
  });

  it("needs a place that is a number", () => {
    for (const bad of [undefined, {}, { x: "1", y: 2 }, { x: Infinity, y: 0 }, { x: 0, y: Number.NaN }]) expect(mentionRefusal(asking, bad)).toMatch(/place/);
  });

  it("opens the picker inside the part of the frame in view, wherever the page says", () => {
    const frame = { left: 300, top: -2000, right: 1100, bottom: 6000 };
    const view = { width: 1280, height: 900 };
    expect(pickerPlace({ x: 100, y: 2300 }, frame, view)).toEqual({ x: 400, y: 300 });
    // Far off the screen, below or above, and off to either side: held to the frame's visible edges.
    expect(pickerPlace({ x: 100, y: 99_999 }, frame, view)).toEqual({ x: 400, y: 900 });
    expect(pickerPlace({ x: -5000, y: -5000 }, frame, view)).toEqual({ x: 300, y: 0 });
    expect(pickerPlace({ x: 99_999, y: 2300 }, frame, view)).toEqual({ x: 1100, y: 300 });
  });
});

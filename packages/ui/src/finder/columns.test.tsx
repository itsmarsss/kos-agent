// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type DirEntry } from "../api.js";
import { columnsTemplate, LIST_COLUMNS, LIST_WIDTHS_KEY, PANEL_WIDTHS_KEY, readWidths, TRASH_WIDTHS_KEY } from "./columns.js";
import { ListView } from "./ListView.js";
import type { RowHandlers } from "./rows.js";
import { TrashView } from "./TrashView.js";

/**
 * The list's columns, resized as Finder's are: a divider at each column's
 * left edge, dragged or moved by the keys, the widths kept per browser,
 * the same in the trash. Fitting and narrow Finders need layout: they are
 * in columns.chrome.test.ts.
 */

const entry = (name: string): DirEntry => ({ name, path: name, kind: "file", size: 10, modifiedAt: 1 });
const h: RowHandlers = {
  selected: new Set(),
  lead: null,
  editing: null,
  over: null,
  press: () => undefined,
  open: () => undefined,
  menu: () => undefined,
  renamed: () => undefined,
  drag: () => ({ draggable: true, onDragStart: () => undefined, onDragEnd: () => undefined }),
  drop: () => ({ onDragOver: () => undefined, onDragLeave: () => undefined, onDrop: () => undefined }),
};
const list = (): void => {
  render(<ListView rows={[{ entry: entry("a.md"), depth: 0 }, { entry: entry("b.md"), depth: 0 }]} sort={{ key: "name", desc: false }} onSort={() => undefined} h={h} empty="Empty" />);
};
const cols = (): string => (document.querySelector<HTMLElement>(".finder-list")!.style.getPropertyValue("--finder-cols"));
const kept = (key: string): unknown => JSON.parse(localStorage.getItem(key) ?? "null");

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the widths a browser keeps", () => {
  it("starts from the defaults, holds kept widths to their bounds and ignores what it cannot read", () => {
    expect(readWidths(LIST_WIDTHS_KEY, LIST_COLUMNS)).toEqual({ modified: 184, size: 88, kind: 152 });
    localStorage.setItem(LIST_WIDTHS_KEY, JSON.stringify({ modified: 10, size: 9000, kind: "wide", other: 3 }));
    expect(readWidths(LIST_WIDTHS_KEY, LIST_COLUMNS)).toEqual({ modified: 96, size: 480, kind: 152 });
    localStorage.setItem(LIST_WIDTHS_KEY, "{not json");
    expect(readWidths(LIST_WIDTHS_KEY, LIST_COLUMNS)).toEqual({ modified: 184, size: 88, kind: 152 });
  });

  it("falls back to the defaults where the browser keeps nothing at all", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    list();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Kind" }), { key: "ArrowLeft" });
    expect(cols()).toBe("minmax(176px, 1fr) minmax(96px, 184px) minmax(56px, 88px) minmax(72px, 160px)");
  });

  it("lays Name out flexible and the rest at their widths", () => {
    expect(columnsTemplate(LIST_COLUMNS, { modified: 200, size: 60, kind: 100 })).toBe("minmax(176px, 1fr) minmax(96px, 200px) minmax(56px, 60px) minmax(72px, 100px)");
    expect(columnsTemplate(LIST_COLUMNS, { modified: 200, size: 60, kind: 100 }, "15rem")).toBe("minmax(176px, 1fr) minmax(96px, 200px) minmax(56px, 60px) minmax(72px, 100px) 15rem");
  });
});

describe("a divider in the list's head", () => {
  it("is one per column after Name, in that column's head, a focusable separator that says the width", () => {
    list();
    expect(screen.getAllByRole("columnheader").map((c) => [c.textContent, c.querySelector('[role="separator"]')?.getAttribute("aria-label") ?? null])).toEqual([
      ["Name", null],
      ["Date Modified", "Resize Date Modified"],
      ["Size", "Resize Size"],
      ["Kind", "Resize Kind"],
    ]);
    const dividers = screen.getAllByRole("separator");
    expect(dividers.map((d) => d.getAttribute("aria-label"))).toEqual(["Resize Date Modified", "Resize Size", "Resize Kind"]);
    expect(dividers.map((d) => d.getAttribute("aria-valuenow"))).toEqual(["184", "88", "152"]);
    expect(dividers.every((d) => d.tabIndex === 0 && d.getAttribute("aria-orientation") === "vertical")).toBe(true);
    expect(cols()).toBe("minmax(176px, 1fr) minmax(96px, 184px) minmax(56px, 88px) minmax(72px, 152px)");
  });

  it("moves with the arrows, further with Shift, never under the column's least, and keeps the width", () => {
    list();
    const modified = screen.getByRole("separator", { name: "Resize Date Modified" });
    fireEvent.keyDown(modified, { key: "ArrowLeft" });
    expect(modified.getAttribute("aria-valuenow")).toBe("192");
    fireEvent.keyDown(modified, { key: "ArrowRight", shiftKey: true });
    expect(modified.getAttribute("aria-valuenow")).toBe("160");
    for (let i = 0; i < 5; i++) fireEvent.keyDown(modified, { key: "ArrowRight", shiftKey: true });
    expect(modified.getAttribute("aria-valuenow")).toBe("96");
    expect(cols()).toBe("minmax(176px, 1fr) minmax(96px, 96px) minmax(56px, 88px) minmax(72px, 152px)");
    expect(kept(LIST_WIDTHS_KEY)).toEqual({ modified: 96, size: 88, kind: 152 });
  });

  it("follows a drag, its column growing as the divider goes left, and keeps the width when let go", () => {
    list();
    const size = screen.getByRole("separator", { name: "Resize Size" });
    fireEvent.pointerDown(size, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(size, { clientX: 560, pointerId: 1 });
    expect(cols()).toBe("minmax(176px, 1fr) minmax(96px, 184px) minmax(56px, 128px) minmax(72px, 152px)");
    expect(size.classList.contains("is-dragging")).toBe(true);
    expect(kept(LIST_WIDTHS_KEY)).toBeNull();
    fireEvent.pointerUp(size, { clientX: 550, pointerId: 1 });
    expect(kept(LIST_WIDTHS_KEY)).toEqual({ modified: 184, size: 138, kind: 152 });
    expect(size.classList.contains("is-dragging")).toBe(false);
    // A move after letting go changes nothing.
    fireEvent.pointerMove(size, { clientX: 300, pointerId: 1 });
    expect(cols()).toBe("minmax(176px, 1fr) minmax(96px, 184px) minmax(56px, 138px) minmax(72px, 152px)");
  });

  it("does not let a sort happen under it: the head's own button keeps its press", () => {
    const onSort = vi.fn();
    render(<ListView rows={[]} sort={{ key: "name", desc: false }} onSort={onSort} h={h} empty="Empty" />);
    fireEvent.click(screen.getByRole("separator", { name: "Resize Kind" }));
    expect(onSort).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Kind" }));
    expect(onSort).toHaveBeenCalledWith({ key: "kind", desc: false });
  });

  it("keeps a panel's widths apart from the Files page's", () => {
    render(<ListView rows={[]} sort={{ key: "name", desc: false }} onSort={() => undefined} h={h} empty="Empty" widthsKey={PANEL_WIDTHS_KEY} />);
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Size" }), { key: "ArrowLeft" });
    expect(kept(PANEL_WIDTHS_KEY)).toEqual({ modified: 184, size: 96, kind: 152 });
    expect(kept(LIST_WIDTHS_KEY)).toBeNull();
  });

  it("opens at the widths this browser kept", () => {
    localStorage.setItem(LIST_WIDTHS_KEY, JSON.stringify({ modified: 140, size: 70, kind: 200 }));
    list();
    expect(cols()).toBe("minmax(176px, 1fr) minmax(96px, 140px) minmax(56px, 70px) minmax(72px, 200px)");
  });
});

describe("the trash's columns", () => {
  it("resize the same way, kept apart from the list's", async () => {
    vi.spyOn(api, "fileTrash").mockResolvedValue({ items: [{ id: "1-aa", path: "notes/x.md", name: "x.md", kind: "file", size: 3, trashedAt: 1 }] });
    render(<TrashView rootName="Workspace" onChanged={() => undefined} onError={() => undefined} onCount={() => undefined} />);
    const trashed = await screen.findByRole("separator", { name: "Resize Date Trashed" });
    expect(screen.getAllByRole("separator").map((d) => d.getAttribute("aria-label"))).toEqual(["Resize Date Trashed", "Resize Size"]);
    expect(cols()).toBe("minmax(176px, 1fr) minmax(96px, 184px) minmax(56px, 88px) 15rem");
    fireEvent.keyDown(trashed, { key: "ArrowLeft", shiftKey: true });
    expect(cols()).toBe("minmax(176px, 1fr) minmax(96px, 216px) minmax(56px, 88px) 15rem");
    expect(kept(TRASH_WIDTHS_KEY)).toEqual({ trashed: 216, size: 88 });
    expect(kept(LIST_WIDTHS_KEY)).toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type DirEntry } from "../api.js";
import { columnsTemplate, fitColumns, LIST_COLUMNS, LIST_WIDTHS_KEY, NAME_MIN, PANEL_COLUMNS, PANEL_LAYOUT, PANEL_WIDTHS_KEY, readWidths, saveWidths, TRASH_COLUMNS, TRASH_WIDTHS_KEY, widestOf } from "./columns.js";
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

  it("keeps what it saves, one surface apart from another", () => {
    saveWidths(PANEL_WIDTHS_KEY, { modified: 120, size: 64, kind: 90 });
    expect(readWidths(PANEL_WIDTHS_KEY, PANEL_COLUMNS)).toEqual({ modified: 120, size: 64, kind: 90 });
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
    expect(cols()).toBe("minmax(0, 1fr) 184px 88px 160px");
  });

  it("lays Name out flexible and the rest at their widths", () => {
    expect(columnsTemplate(LIST_COLUMNS, { modified: 200, size: 60, kind: 100 })).toBe("minmax(0, 1fr) 200px 60px 100px");
    expect(columnsTemplate(LIST_COLUMNS, { modified: 200, size: 60, kind: 100 }, 240)).toBe("minmax(0, 1fr) 200px 60px 100px 240px");
  });
});

describe("the columns that fit", () => {
  const all = { modified: 184, size: 88, kind: 152 };
  const at = (room: number, widths = all): string[] => fitColumns(room, LIST_COLUMNS, widths);

  it("shows every column with room for all of them beside Name's least", () => {
    expect(at(NAME_MIN + 184 + 88 + 152)).toEqual(["modified", "size", "kind"]);
  });

  it("hides Kind, then Date, then Size as the room goes, and brings them back as it returns", () => {
    expect(at(NAME_MIN + 184 + 88 + 151)).toEqual(["modified", "size"]);
    expect(at(NAME_MIN + 184 + 88)).toEqual(["modified", "size"]);
    expect(at(NAME_MIN + 184 + 87)).toEqual(["size"]);
    expect(at(NAME_MIN + 88)).toEqual(["size"]);
    expect(at(NAME_MIN + 87)).toEqual([]);
    expect(at(1440)).toEqual(["modified", "size", "kind"]);
  });

  it("never shows a column of a lower rank when one above it does not fit", () => {
    // Kind is narrow enough to fit where Date does not, and still hides first.
    expect(at(NAME_MIN + 88 + 100, { modified: 300, size: 88, kind: 80 })).toEqual(["size"]);
  });

  it("counts a fixed tail, and shows everything where nothing is laid out", () => {
    expect(fitColumns(NAME_MIN + 240 + 88, TRASH_COLUMNS, { trashed: 184, size: 88 }, 240)).toEqual(["size"]);
    expect(at(0)).toEqual(["modified", "size", "kind"]);
  });

  it("gives a panel beside a chat its narrower widths: Size at 300 and 380, every column at 520", () => {
    const keys = (room: number): string[] => fitColumns(room, PANEL_COLUMNS, readWidths(PANEL_WIDTHS_KEY, PANEL_COLUMNS));
    expect(keys(300 - 14)).toEqual(["size"]);
    expect(keys(380 - 14)).toEqual(["size"]);
    expect(keys(440 - 14)).toEqual(["modified", "size"]);
    expect(keys(520 - 14)).toEqual(["modified", "size", "kind"]);
  });

  it("lets a column grow only as far as Name and the other shown columns leave it", () => {
    const shown = LIST_COLUMNS.filter((c) => c.key !== "kind");
    expect(widestOf(LIST_COLUMNS[1]!, 500, shown, all)).toBe(500 - NAME_MIN - 184);
    expect(widestOf(LIST_COLUMNS[1]!, 300, shown, all)).toBe(56);
    expect(widestOf(LIST_COLUMNS[1]!, 0, shown, all)).toBe(480);
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
    expect(cols()).toBe("minmax(0, 1fr) 184px 88px 152px");
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
    expect(cols()).toBe("minmax(0, 1fr) 96px 88px 152px");
    expect(kept(LIST_WIDTHS_KEY)).toEqual({ modified: 96, size: 88, kind: 152 });
  });

  it("follows a drag, its column growing as the divider goes left, and keeps the width when let go", () => {
    list();
    const size = screen.getByRole("separator", { name: "Resize Size" });
    fireEvent.pointerDown(size, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerMove(size, { clientX: 560, pointerId: 1 });
    expect(cols()).toBe("minmax(0, 1fr) 184px 128px 152px");
    expect(size.classList.contains("is-dragging")).toBe(true);
    expect(kept(LIST_WIDTHS_KEY)).toBeNull();
    fireEvent.pointerUp(size, { clientX: 550, pointerId: 1 });
    expect(kept(LIST_WIDTHS_KEY)).toEqual({ modified: 184, size: 138, kind: 152 });
    expect(size.classList.contains("is-dragging")).toBe(false);
    // A move after letting go changes nothing.
    fireEvent.pointerMove(size, { clientX: 300, pointerId: 1 });
    expect(cols()).toBe("minmax(0, 1fr) 184px 138px 152px");
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
    render(<ListView rows={[]} sort={{ key: "name", desc: false }} onSort={() => undefined} h={h} empty="Empty" layout={PANEL_LAYOUT} />);
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Size" }), { key: "ArrowLeft" });
    expect(kept(PANEL_WIDTHS_KEY)).toEqual({ modified: 140, size: 88, kind: 116 });
    expect(kept(LIST_WIDTHS_KEY)).toBeNull();
  });

  it("opens at the widths this browser kept", () => {
    localStorage.setItem(LIST_WIDTHS_KEY, JSON.stringify({ modified: 140, size: 70, kind: 200 }));
    list();
    expect(cols()).toBe("minmax(0, 1fr) 140px 70px 200px");
  });
});

describe("the trash's columns", () => {
  it("resize the same way, kept apart from the list's", async () => {
    vi.spyOn(api, "fileTrash").mockResolvedValue({ items: [{ id: "1-aa", path: "notes/x.md", name: "x.md", kind: "file", size: 3, trashedAt: 1 }] });
    render(<TrashView rootName="Workspace" onChanged={() => undefined} onError={() => undefined} onCount={() => undefined} />);
    const trashed = await screen.findByRole("separator", { name: "Resize Date Trashed" });
    expect(screen.getAllByRole("separator").map((d) => d.getAttribute("aria-label"))).toEqual(["Resize Date Trashed", "Resize Size"]);
    expect(cols()).toBe("minmax(0, 1fr) 184px 88px 240px");
    fireEvent.keyDown(trashed, { key: "ArrowLeft", shiftKey: true });
    expect(cols()).toBe("minmax(0, 1fr) 216px 88px 240px");
    expect(kept(TRASH_WIDTHS_KEY)).toEqual({ trashed: 216, size: 88 });
    expect(kept(LIST_WIDTHS_KEY)).toBeNull();
  });
});

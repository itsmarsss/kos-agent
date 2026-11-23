// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type DirEntry, type FileContent } from "../api.js";
import { Finder } from "./Finder.js";
import { ToastHost } from "../Toast.js";

// The app mounts the one toast host; a page on its own here gets one too.
beforeEach(() => void render(<ToastHost />));

/**
 * The file manager as Finder has it: choosing by click, Shift and Cmd, the
 * keys, Quick Look on Space, renaming in place, moving by a drag, the trash
 * and back, and one column at a phone's width.
 */

const d = (path: string, kind: "dir" | "file" = "file", size = 10): DirEntry => ({ name: path.split("/").pop()!, path, kind, size, modifiedAt: 1 });

let tree: Record<string, DirEntry[]>;
const main = (): HTMLElement => document.querySelector(".finder-main") as HTMLElement;
const row = (path: string): HTMLElement => [...document.querySelectorAll<HTMLElement>("[data-path]")].find((el) => el.dataset.path === path)!;
const chosen = (): string[] => [...document.querySelectorAll<HTMLElement>(".is-selected")].map((el) => el.dataset.path!);
const key = (k: string, mods: Partial<KeyboardEventInit> = {}): void => {
  fireEvent.keyDown(main(), { key: k, ...mods });
};

function transfer(): DataTransfer {
  const data: Record<string, string> = {};
  return {
    get types() {
      return Object.keys(data);
    },
    getData: (t: string) => data[t] ?? "",
    setData: (t: string, v: string) => {
      data[t] = v;
    },
    files: [],
    dropEffect: "none",
    effectAllowed: "all",
  } as unknown as DataTransfer;
}

beforeEach(() => {
  tree = {
    ".": [d("projects", "dir"), d("downloads", "dir"), { ...d("kos.sqlite"), reserved: true }],
    projects: [d("projects/garden", "dir")],
    "projects/garden": [d("projects/garden/beds", "dir"), d("projects/garden/a.md"), d("projects/garden/b.txt"), d("projects/garden/plan.docx"), d("projects/garden/c.txt")],
    "projects/garden/beds": [d("projects/garden/beds/bed-1.md")],
    downloads: [],
  };
  vi.stubGlobal("IntersectionObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  vi.spyOn(api, "files").mockImplementation(async (path = ".") => {
    if (!tree[path]) throw new Error(`no such folder: ${path}`);
    return { path, entries: tree[path] };
  });
  vi.spyOn(api, "projects").mockResolvedValue([{ slug: "garden", name: "Garden", type: "project", status: "active", lastTouchedAt: 0 }]);
  vi.spyOn(api, "file").mockImplementation(async (path): Promise<FileContent> => ({ path, size: 10, modifiedAt: 1, text: `words of ${path}`, language: "text" }));
  try {
    localStorage.clear();
  } catch {
    // jsdom always has it.
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openGarden(props: Partial<Parameters<typeof Finder>[0]> = {}) {
  const onAsk = vi.fn();
  render(<Finder path="projects/garden" onAsk={onAsk} {...props} />);
  await screen.findByText("a.md");
  return { onAsk };
}

describe("the finder", () => {
  it("chooses by click, Shift and Cmd, and moves the choice with the arrows", async () => {
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/a.md"));
    expect(chosen()).toEqual(["projects/garden/a.md"]);
    fireEvent.mouseDown(row("projects/garden/plan.docx"), { shiftKey: true });
    expect(chosen()).toEqual(["projects/garden/a.md", "projects/garden/b.txt", "projects/garden/c.txt", "projects/garden/plan.docx"]);
    fireEvent.mouseDown(row("projects/garden/b.txt"), { metaKey: true });
    expect(chosen()).toEqual(["projects/garden/a.md", "projects/garden/c.txt", "projects/garden/plan.docx"]);
    key("ArrowUp");
    expect(chosen()).toEqual(["projects/garden/c.txt"]);
    key("ArrowUp", { shiftKey: true });
    expect(chosen()).toEqual(["projects/garden/b.txt", "projects/garden/c.txt"]);
    key("a", { metaKey: true });
    expect(chosen()).toHaveLength(5);
    expect(screen.getByText("5 of 5 items")).toBeTruthy();
  });

  it("goes to a name as it is typed", async () => {
    await openGarden();
    key("p");
    expect(chosen()).toEqual(["projects/garden/plan.docx"]);
    key("b");
    // "pb" names nothing; a pause starts the name again.
    expect(chosen()).toEqual(["projects/garden/plan.docx"]);
  });

  it("opens Quick Look on Space, steps with the arrows, and closes on Space", async () => {
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/a.md"));
    key(" ");
    expect(await screen.findByRole("dialog", { name: "Quick Look: a.md" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".preview-pre")?.textContent).toBe("words of projects/garden/a.md"));
    key("ArrowDown");
    expect(await screen.findByRole("dialog", { name: "Quick Look: b.txt" })).toBeTruthy();
    key(" ");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens a folder in place under its triangle, and into it on Cmd+Down, and back on Cmd+Up", async () => {
    await openGarden();
    fireEvent.click(screen.getByRole("button", { name: "Open beds here" }));
    expect(await screen.findByText("bed-1.md")).toBeTruthy();
    fireEvent.mouseDown(row("projects/garden/beds"));
    key("ArrowLeft");
    await waitFor(() => expect(screen.queryByText("bed-1.md")).toBeNull());
    key("ArrowDown", { metaKey: true });
    await screen.findByText("bed-1.md");
    expect(screen.queryByText("a.md")).toBeNull();
    key("ArrowUp", { metaKey: true });
    await screen.findByText("a.md");
  });

  it("renames in place on Return, keeping the extension out of the selection", async () => {
    const rename = vi.spyOn(api, "renameFile").mockResolvedValue({ path: "projects/garden/notes.md" });
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/a.md"));
    key("Enter");
    const field = screen.getByRole("textbox", { name: "Rename a.md" }) as HTMLInputElement;
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 1]);
    fireEvent.change(field, { target: { value: "notes.md" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(rename).toHaveBeenCalledWith("projects/garden/a.md", "projects/garden/notes.md"));
  });

  it("moves what is dragged onto a folder, a sidebar place, or the path", async () => {
    const rename = vi.spyOn(api, "renameFile").mockImplementation(async (_from, to) => ({ path: to }));
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/a.md"));
    fireEvent.mouseDown(row("projects/garden/b.txt"), { metaKey: true });
    const dt = transfer();
    fireEvent.dragStart(row("projects/garden/b.txt"), { dataTransfer: dt });
    fireEvent.dragOver(row("projects/garden/beds"), { dataTransfer: dt });
    expect(row("projects/garden/beds").className).toContain("is-drop");
    fireEvent.drop(row("projects/garden/beds"), { dataTransfer: dt });
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(2));
    expect(rename).toHaveBeenCalledWith("projects/garden/a.md", "projects/garden/beds/a.md");
    expect(rename).toHaveBeenCalledWith("projects/garden/b.txt", "projects/garden/beds/b.txt");

    const one = transfer();
    fireEvent.dragStart(row("projects/garden/c.txt"), { dataTransfer: one });
    fireEvent.drop(within(screen.getByRole("navigation", { name: "Locations" })).getByRole("button", { name: "Downloads" }), { dataTransfer: one });
    await waitFor(() => expect(rename).toHaveBeenCalledWith("projects/garden/c.txt", "downloads/c.txt"));
  });

  it("undoes a move and a rename", async () => {
    const rename = vi.spyOn(api, "renameFile").mockImplementation(async (_from, to) => ({ path: to }));
    await openGarden();
    const dt = transfer();
    fireEvent.dragStart(row("projects/garden/a.md"), { dataTransfer: dt });
    fireEvent.drop(row("projects/garden/beds"), { dataTransfer: dt });
    expect(await screen.findByText("Moved a.md to beds")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(rename).toHaveBeenLastCalledWith("projects/garden/beds/a.md", "projects/garden/a.md"));
    fireEvent.mouseDown(row("projects/garden/b.txt"));
    key("Enter");
    const field = screen.getByRole("textbox", { name: "Rename b.txt" });
    fireEvent.change(field, { target: { value: "c2.txt" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByText("Renamed to c2.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(rename).toHaveBeenLastCalledWith("projects/garden/c2.txt", "projects/garden/b.txt"));
  });

  it("moves nothing for a drop of its type that it did not start", async () => {
    const rename = vi.spyOn(api, "renameFile").mockResolvedValue({ path: "x" });
    await openGarden();
    const forged = transfer();
    forged.setData("application/x-kos-paths", JSON.stringify({ token: "guess", paths: ["projects/garden/a.md"] }));
    fireEvent.drop(row("projects/garden/beds"), { dataTransfer: forged });
    const old = transfer();
    fireEvent.dragStart(row("projects/garden/a.md"), { dataTransfer: old });
    fireEvent.dragEnd(row("projects/garden/a.md"));
    fireEvent.drop(row("projects/garden/beds"), { dataTransfer: old });
    await new Promise((r) => setTimeout(r, 50));
    expect(rename).not.toHaveBeenCalled();
  });

  it("moves to the trash on Cmd+Delete, with an Undo that puts it back", async () => {
    const trash = vi.spyOn(api, "trashFile").mockResolvedValue({ id: "1-aa", path: "projects/garden/a.md", name: "a.md", kind: "file", size: 1, trashedAt: 1 });
    const restore = vi.spyOn(api, "restoreFile").mockResolvedValue({ path: "projects/garden/a.md" });
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/a.md"));
    key("Backspace", { metaKey: true });
    await waitFor(() => expect(trash).toHaveBeenCalledWith("projects/garden/a.md"));
    expect(await screen.findByText("Moved a.md to the Trash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("1-aa"));
  });

  it("empties the trash only once asked and answered", async () => {
    vi.spyOn(api, "fileTrash").mockResolvedValue({ items: [{ id: "1-aa", path: "notes/x.md", name: "x.md", kind: "file", size: 3, trashedAt: 1 }] });
    const empty = vi.spyOn(api, "emptyFileTrash").mockResolvedValue({ removed: 1 });
    const restore = vi.spyOn(api, "restoreFile").mockResolvedValue({ path: "notes/x.md" });
    await openGarden();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Locations" })).getByRole("button", { name: "Trash" }));
    expect(await screen.findByText("x.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("1-aa"));
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    expect(empty).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Empty trash" }));
    await waitFor(() => expect(empty).toHaveBeenCalledWith());
  });

  it("shows columns with the chosen file's facts at the end, and remembers the view per folder", async () => {
    vi.spyOn(api, "fileInfo").mockImplementation(async (path) => ({ ...d(path), createdAt: 1, project: { slug: "garden", name: "Garden" } }));
    await openGarden();
    fireEvent.click(screen.getByRole("button", { name: "View as columns (Cmd+2)" }));
    fireEvent.mouseDown(row("projects/garden/beds"));
    expect(await screen.findByText("bed-1.md")).toBeTruthy();
    fireEvent.mouseDown(row("projects/garden/beds/bed-1.md"));
    expect(await screen.findByText("Project")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("kos.finder.views")!)).toEqual({ "projects/garden": "columns" });
  });

  it("hides KOS's own files until asked, and remembers the choice", async () => {
    render(<Finder path="." />);
    await screen.findByText("projects");
    expect(screen.queryByText("kos.sqlite")).toBeNull();
    fireEvent.contextMenu(main(), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Show KOS's files" }));
    expect(await screen.findByText("kos.sqlite")).toBeTruthy();
    expect(localStorage.getItem("kos.finder.showOwn")).toBe("1");
  });

  it("opens on a tap and asks for the menu on a long press: a finger has no double press or other button", async () => {
    await openGarden();
    const tap = (el: HTMLElement): void => {
      fireEvent.pointerDown(el, { pointerType: "touch", clientX: 5, clientY: 5 });
      fireEvent.mouseDown(el);
      fireEvent.pointerUp(el, { pointerType: "touch" });
      fireEvent.click(el);
    };
    tap(row("projects/garden/a.md"));
    expect(await screen.findByRole("dialog", { name: "Quick Look: a.md" })).toBeTruthy();
    fireEvent.keyDown(main(), { key: " " });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // A click from a mouse still only chooses.
    fireEvent.pointerDown(row("projects/garden/b.txt"), { pointerType: "mouse" });
    fireEvent.mouseDown(row("projects/garden/b.txt"));
    fireEvent.click(row("projects/garden/b.txt"));
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(row("projects/garden/c.txt"), { pointerType: "touch", clientX: 5, clientY: 5 });
      act(() => vi.advanceTimersByTime(600));
      fireEvent.pointerUp(row("projects/garden/c.txt"), { pointerType: "touch" });
      fireEvent.click(row("projects/garden/c.txt"));
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByRole("menu", { name: "Actions for c.txt" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Quick Look: c.txt" })).toBeNull();
  });

  it("names a folder before making it at the workspace's top level, which cannot be renamed after", async () => {
    const make = vi.spyOn(api, "makeDir").mockResolvedValue({ path: "garden" });
    render(<Finder path="." />);
    await screen.findByText("projects");
    key("n", { shiftKey: true, metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    expect(make).not.toHaveBeenCalled();
    const field = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(field.value).toBe("untitled folder");
    fireEvent.change(field, { target: { value: "garden" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(make).toHaveBeenCalledWith("garden"));
  });

  it("marks KOS's own files and offers nothing that would change them, saying why", async () => {
    const trash = vi.spyOn(api, "trashFile");
    localStorage.setItem("kos.finder.showOwn", "1");
    render(<Finder path="." />);
    await screen.findByText("kos.sqlite");
    const own = row("kos.sqlite");
    expect(own.dataset.reserved).toBe("true");
    expect(own.getAttribute("draggable")).toBe("false");
    fireEvent.contextMenu(own, { clientX: 5, clientY: 5 });
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
    expect(items.some((t) => t.startsWith("Get Info"))).toBe(true);
    for (const word of ["Rename", "Duplicate", "Move to", "Move to Trash"]) expect(items.some((t) => t.startsWith(word))).toBe(false);
    expect(items).toContain("KOS's own file: it can't be renamed, moved or trashed");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(own);
    key("Enter");
    expect(screen.queryByRole("textbox", { name: "Rename kos.sqlite" })).toBeNull();
    key("Backspace", { metaKey: true });
    expect(trash).not.toHaveBeenCalled();
  });

  it("asks KOS about what is chosen, and shows its facts on Cmd+I", async () => {
    vi.spyOn(api, "fileInfo").mockResolvedValue({ ...d("projects/garden/plan.docx"), createdAt: 1, pages: 3, pagesUnit: "pages" });
    const { onAsk } = await openGarden();
    fireEvent.contextMenu(row("projects/garden/plan.docx"), { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask KOS about this" }));
    expect(onAsk).toHaveBeenCalledWith(["projects/garden/plan.docx"]);
    fireEvent.mouseDown(row("projects/garden/plan.docx"));
    key("i", { metaKey: true });
    expect(await screen.findByText("Pages")).toBeTruthy();
    expect(screen.getByText("Word document", { selector: "dd" })).toBeTruthy();
  });

  it("chooses the copy after Cmd+D, so the next Cmd+Delete trashes the copy and not the original", async () => {
    vi.spyOn(api, "copyFile").mockImplementation(async (from) => {
      const made = from.replace(/\.md$/, " copy.md");
      tree["projects/garden"]!.push(d(made));
      return { path: made };
    });
    const trash = vi.spyOn(api, "trashFile").mockResolvedValue({ id: "1-aa", path: "projects/garden/a copy.md", name: "a copy.md", kind: "file", size: 1, trashedAt: 1 });
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/a.md"));
    key("d", { metaKey: true });
    await waitFor(() => expect(chosen()).toEqual(["projects/garden/a copy.md"]));
    key("Backspace", { metaKey: true });
    await waitFor(() => expect(trash).toHaveBeenCalledWith("projects/garden/a copy.md"));
    expect(trash).not.toHaveBeenCalledWith("projects/garden/a.md");
  });

  it("opens the chosen file's own menu on the menu key and Shift+F10, and the folder's with nothing chosen", async () => {
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/a.md"));
    key("ContextMenu");
    expect(screen.getByRole("menu", { name: "Actions for a.md" })).toBeTruthy();
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
    for (const word of ["Rename", "Move to", "Move to Trash"]) expect(items.some((t) => t.startsWith(word))).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    key("F10", { shiftKey: true });
    expect(screen.getByRole("menu", { name: "Actions for a.md" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // The menu key's own contextmenu event, on the list rather than a row, is the same menu.
    fireEvent.contextMenu(main(), { button: 0 });
    expect(screen.getByRole("menu", { name: "Actions for a.md" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    key("Escape");
    key("ContextMenu");
    expect(screen.getByRole("menu", { name: "Folder actions" })).toBeTruthy();
  });

  it("gives the keys back to the list, choice kept, when the Actions menu shuts on Escape", async () => {
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/b.txt"));
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu", { name: "Actions" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(main());
    expect(chosen()).toEqual(["projects/garden/b.txt"]);
  });

  it("chooses the folder come up out of on Cmd+Up", async () => {
    await openGarden();
    key("ArrowUp", { metaKey: true });
    await waitFor(() => expect(chosen()).toEqual(["projects/garden"]));
  });

  it("shuts Info on Escape and on Cmd+I again, leaving the choice behind it alone", async () => {
    vi.spyOn(api, "fileInfo").mockResolvedValue({ ...d("projects/garden/a.md"), createdAt: 1 });
    await openGarden();
    fireEvent.mouseDown(row("projects/garden/a.md"));
    key("i", { metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Info" })).toBeTruthy();
    key("Escape");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Info" })).toBeNull());
    expect(chosen()).toEqual(["projects/garden/a.md"]);
    key("i", { metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Info" })).toBeTruthy();
    key("i", { metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Info" })).toBeNull());
    expect(chosen()).toEqual(["projects/garden/a.md"]);
  });

  it("finds by name below the folder", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const search = vi.spyOn(api, "searchFiles").mockResolvedValue({ entries: [d("projects/garden/beds/bed-1.md")], truncated: false });
    try {
      await openGarden();
      fireEvent.change(screen.getByRole("searchbox", { name: "Search this folder and below" }), { target: { value: "bed" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(search).toHaveBeenCalledWith("projects/garden", "bed", false, expect.any(AbortSignal));
      expect(await screen.findByText("bed-1.md")).toBeTruthy();
      expect(screen.getByText("projects/garden/beds")).toBeTruthy();
      // The next keystroke drops the search before it.
      fireEvent.change(screen.getByRole("searchbox", { name: "Search this folder and below" }), { target: { value: "beds" } });
      expect((search.mock.calls[0]![3] as AbortSignal).aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is one column at a phone's width: no sidebar, no columns view, places in a menu", async () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(): void {
        this.cb([{ contentRect: { width: 390 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve(): void {}
      disconnect(): void {}
    });
    await openGarden();
    expect(document.querySelector(".finder--narrow")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Locations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View as columns (Cmd+2)" })).toBeNull();
    expect(screen.getByRole("button", { name: /Go to/ })).toBeTruthy();
  });
});

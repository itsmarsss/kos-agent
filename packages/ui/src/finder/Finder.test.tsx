// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type DirEntry, type FileContent } from "../api.js";
import { Finder } from "./Finder.js";

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
    ".": [d("projects", "dir"), d("downloads", "dir"), d("kos.sqlite")],
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
    fireEvent.click(screen.getByRole("button", { name: "Put Back" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("1-aa"));
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));
    expect(empty).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Empty the Trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Empty Trash" }));
    await waitFor(() => expect(empty).toHaveBeenCalledWith());
  });

  it("shows columns with the chosen file's facts at the end, and remembers the view per folder", async () => {
    vi.spyOn(api, "fileInfo").mockImplementation(async (path) => ({ ...d(path), createdAt: 1, project: { slug: "garden", name: "Garden" } }));
    await openGarden();
    fireEvent.click(screen.getByRole("button", { name: "as Columns (Cmd+2)" }));
    fireEvent.mouseDown(row("projects/garden/beds"));
    expect(await screen.findByText("bed-1.md")).toBeTruthy();
    fireEvent.mouseDown(row("projects/garden/beds/bed-1.md"));
    expect(await screen.findByText("Project")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("kos.finder.views")!)).toEqual({ "projects/garden": "columns" });
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

  it("finds by name below the folder", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const search = vi.spyOn(api, "searchFiles").mockResolvedValue({ entries: [d("projects/garden/beds/bed-1.md")], truncated: false });
    try {
      await openGarden();
      fireEvent.change(screen.getByRole("searchbox", { name: "Search this folder and below" }), { target: { value: "bed" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(search).toHaveBeenCalledWith("projects/garden", "bed", false);
      expect(await screen.findByText("bed-1.md")).toBeTruthy();
      expect(screen.getByText("projects/garden/beds")).toBeTruthy();
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
      disconnect(): void {}
    });
    await openGarden();
    expect(document.querySelector(".finder--narrow")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Locations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "as Columns (Cmd+2)" })).toBeNull();
    expect(screen.getByRole("button", { name: /Go to/ })).toBeTruthy();
  });
});

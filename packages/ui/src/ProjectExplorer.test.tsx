// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type DirEntry, type FileContent } from "./api.js";
import { ProjectExplorer } from "./ProjectExplorer.js";

/**
 * The project's folder, browsed without leaving the chat: the same file
 * manager as Files, kept inside the project, its uploads landing in the
 * folder being looked at, and its questions going to the chat beside it.
 */

const slug = "kitchen_redo";
const root = `projects/${slug}`;

function entry(name: string, kind: "dir" | "file", dir = root, size = 0): DirEntry {
  return { name, path: `${dir}/${name}`, kind, size, modifiedAt: 0 };
}

let tree: Record<string, DirEntry[]>;
const contents: Record<string, FileContent> = {
  [`${root}/plan.md`]: { path: `${root}/plan.md`, size: 2048, modifiedAt: 0, text: "# Plan\n\nTiles first.", language: "markdown" },
  [`${root}/cat.png`]: { path: `${root}/cat.png`, size: 10, modifiedAt: 0, omitted: "binary", language: "" },
};

const row = (path: string): HTMLElement => document.querySelector(`[data-path="${path}"]`) as HTMLElement;

function open(onAsk = vi.fn()) {
  const h = { onOpenInFiles: vi.fn(), onChanged: vi.fn(), onAsk };
  render(<ProjectExplorer label={slug} root={root} upload={(file, dir) => api.uploadProjectFile(slug, file, dir)} {...h} />);
  return h;
}

beforeEach(() => {
  tree = {
    [root]: [entry("plan.md", "file", root, 2048), entry("pages", "dir"), entry("cat.png", "file", root, 10)],
    [`${root}/pages`]: [entry("board.html", "file", `${root}/pages`, 300)],
  };
  vi.stubGlobal("IntersectionObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  vi.spyOn(api, "files").mockImplementation(async (path = ".") => ({ path, entries: tree[path] ?? [] }));
  vi.spyOn(api, "file").mockImplementation(async (path) => {
    const f = contents[path];
    if (!f) throw new Error(`no such file: ${path}`);
    return f;
  });
  vi.spyOn(api, "imageUrl").mockResolvedValue("blob:cat");
  (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL ??= () => undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the project explorer", () => {
  it("lists the project's folder, folders first, kept inside the project", async () => {
    open();
    await screen.findByText("plan.md");
    const names = [...document.querySelectorAll(".finder-row .finder-name")].map((n) => n.textContent);
    expect(names).toEqual(["pages", "cat.png", "plan.md"]);
    expect(screen.getByText("2 KB")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Locations" })).toBeNull();

    fireEvent.doubleClick(row(`${root}/pages`));
    await screen.findByText("board.html");
    expect(api.files).toHaveBeenCalledWith(`${root}/pages`);
    // Up from the project's own folder goes nowhere: it is the root here.
    fireEvent.keyDown(document.querySelector(".finder-main")!, { key: "ArrowUp", metaKey: true });
    await screen.findByText("plan.md");
    fireEvent.keyDown(document.querySelector(".finder-main")!, { key: "ArrowUp", metaKey: true });
    expect(screen.getByText("plan.md")).toBeTruthy();
  });

  it("looks at a file in Quick Look and leaves for Files only when asked", async () => {
    const h = open();
    fireEvent.doubleClick(await screen.findByText("plan.md"));
    expect(await screen.findByText("Tiles first.")).toBeTruthy();
    expect(h.onOpenInFiles).not.toHaveBeenCalled();
    fireEvent.contextMenu(row(`${root}/plan.md`), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Show in Files/ }));
    expect(h.onOpenInFiles).toHaveBeenCalledWith(`${root}/plan.md`);
  });

  it("asks about a file in the chat beside it", async () => {
    const h = open();
    fireEvent.contextMenu(await screen.findByText("cat.png"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Ask KOS about this" }));
    expect(h.onAsk).toHaveBeenCalledWith([`${root}/cat.png`]);
  });

  it("uploads into the folder being looked at, relative to the project, then re-reads it", async () => {
    const upload = vi.spyOn(api, "uploadProjectFile").mockResolvedValue({ path: `${root}/pages/notes.txt`, size: 5 });
    const h = open();
    fireEvent.doubleClick(await screen.findByText("pages"));
    await screen.findByText("board.html");
    const read = api.files as ReturnType<typeof vi.fn>;
    const before = read.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(upload).toHaveBeenCalledWith(slug, { name: "notes.txt", mediaType: "text/plain", data: btoa("hello") }, "pages"));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(h.onChanged).toHaveBeenCalled());
  });

  it("says which upload failed, and refuses one past the size cap before sending it", async () => {
    const upload = vi.spyOn(api, "uploadProjectFile").mockRejectedValue(new Error("the disk is full"));
    open();
    await screen.findByText("plan.md");
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 101 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [big, new File(["x"], "small.txt")] } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("big.bin: over the 100 MB a file can be · small.txt: the disk is full"));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("says when the folder is empty", async () => {
    tree[root] = [];
    open();
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
  });
});

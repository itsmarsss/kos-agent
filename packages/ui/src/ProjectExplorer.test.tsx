// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type DirEntry, type FileContent } from "./api.js";
import { ProjectExplorer } from "./ProjectExplorer.js";

/**
 * The project's folder, browsed without leaving the chat: folders open
 * here, files open here, and the Files page is reached only by asking.
 * Uploads land in the folder being looked at.
 */

const slug = "kitchen_redo";
const root = `projects/${slug}`;

function entry(name: string, kind: "dir" | "file", dir = root, size = 0): DirEntry {
  return { name, path: `${dir}/${name}`, kind, size, modifiedAt: 0 };
}

const tree: Record<string, DirEntry[]> = {
  [root]: [entry("plan.md", "file", root, 2048), entry("pages", "dir"), entry("cat.png", "file", root, 10)],
  [`${root}/pages`]: [entry("board.html", "file", `${root}/pages`, 300)],
};

const contents: Record<string, FileContent> = {
  [`${root}/plan.md`]: { path: `${root}/plan.md`, size: 2048, modifiedAt: 0, text: "# Plan\n\nTiles first.", language: "markdown" },
  [`${root}/cat.png`]: { path: `${root}/cat.png`, size: 10, modifiedAt: 0, omitted: "binary", language: "" },
  [`${root}/pages/board.html`]: { path: `${root}/pages/board.html`, size: 300, modifiedAt: 0, text: "<h1>Board</h1>", language: "html" },
};

type Handlers = {
  onOpenInFiles: ReturnType<typeof vi.fn>;
  onChanged: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
};

function open(): Handlers {
  const h: Handlers = { onOpenInFiles: vi.fn(), onChanged: vi.fn(), onError: vi.fn() };
  render(<ProjectExplorer slug={slug} root={root} {...h} />);
  return h;
}

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(api, "files").mockImplementation(async (path = ".") => ({ path, entries: tree[path] ?? [] }));
  vi.spyOn(api, "file").mockImplementation(async (path) => {
    const f = contents[path];
    if (!f) throw new Error(`no such file: ${path}`);
    return f;
  });
  vi.spyOn(api, "imageUrl").mockResolvedValue("blob:cat");
  // jsdom makes object URLs but cannot revoke them; the viewer revokes on the way out.
  (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL ??= () => undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the project explorer", () => {
  it("lists the folder with folders first, and steps into one and back", async () => {
    open();
    await screen.findByText("plan.md");
    const names = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(names[0]).toContain("pages");
    expect(screen.getByText("2.0 KB")).toBeTruthy();

    fireEvent.click(screen.getByText("pages"));
    await screen.findByText("board.html");
    expect(api.files).toHaveBeenCalledWith(`${root}/pages`);
    expect(screen.queryByText("plan.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: slug }));
    await screen.findByText("plan.md");
  });

  it("opens a file in a popup and leaves for Files only when asked", async () => {
    const h = open();
    fireEvent.click(await screen.findByText("plan.md"));
    expect(await screen.findByText("Tiles first.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(h.onOpenInFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Open in Files"));
    expect(h.onOpenInFiles).toHaveBeenCalledWith(`${root}/plan.md`);

    fireEvent.click(screen.getByRole("button", { name: slug }));
    await screen.findByText("cat.png");
  });

  it("shows a picture as a picture", async () => {
    open();
    fireEvent.click(await screen.findByText("cat.png"));
    const img = await screen.findByAltText(`${root}/cat.png`);
    expect(img.getAttribute("src")).toBe("blob:cat");
  });

  it("uploads into the folder being looked at, then re-reads it", async () => {
    const upload = vi.spyOn(api, "uploadProjectFile").mockResolvedValue({ path: `${root}/pages/notes.txt`, size: 5 });
    const h = open();
    fireEvent.click(await screen.findByText("pages"));
    await screen.findByText("board.html");
    const read = api.files as ReturnType<typeof vi.fn>;
    const before = read.mock.calls.length;

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(slug, { name: "notes.txt", mediaType: "text/plain", data: btoa("hello") }, "pages"),
    );
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(h.onChanged).toHaveBeenCalled());
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("says which upload failed", async () => {
    vi.spyOn(api, "uploadProjectFile").mockRejectedValue(new Error("big.bin is 9MB; the limit is 5MB"));
    const h = open();
    await screen.findByText("plan.md");
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [new File(["x"], "big.bin")] } });
    await waitFor(() => expect(h.onError).toHaveBeenCalledWith("big.bin: big.bin is 9MB; the limit is 5MB"));
  });

  it("says when the folder is empty", async () => {
    tree[root] = [];
    try {
      open();
      expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
    } finally {
      tree[root] = [entry("plan.md", "file", root, 2048), entry("pages", "dir"), entry("cat.png", "file", root, 10)];
    }
  });
});

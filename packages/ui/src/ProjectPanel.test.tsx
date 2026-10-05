// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type ProjectDetail } from "./api.js";
import { ProjectPanel } from "./ProjectPanel.js";

/**
 * The column beside a project's threads: what is in its folder and what it
 * has made, each a way in, and the one thing the owner does by hand here,
 * putting a file in, going through the API and then re-reading.
 */

const slug = "kitchen_redo";

function detail(over: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    project: {
      slug,
      name: "Kitchen redo",
      type: "tasks",
      status: "active",
      lastTouchedAt: 1_700_000_000_000,
      createdAt: 1_700_000_000_000,
    },
    tables: [{ name: "items", rows: 5, columns: 4 }],
    pages: [{ id: "tasks_kitchen_redo", projectSlug: slug, title: "Kitchen board", path: "x", updatedAt: 0 }],
    crons: [],
    sites: [],
    sitesBase: null,
    migrations: [],
    activity: [],
    folder: `projects/${slug}`,
    agents: [],
    files: [
      { name: "plan.md", path: `projects/${slug}/plan.md`, kind: "file", size: 2048, modifiedAt: 0 },
      { name: "cat.png", path: `projects/${slug}/cat.png`, kind: "file", size: 10, modifiedAt: 0 },
      { name: "pages", path: `projects/${slug}/pages`, kind: "dir", size: 0, modifiedAt: 0 },
    ],
    ...over,
  };
}

type Handlers = {
  onOpenPage: ReturnType<typeof vi.fn>;
  onOpenFile: ReturnType<typeof vi.fn>;
  onChanged: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
};

function open(over: Partial<ProjectDetail> = {}): Handlers {
  vi.spyOn(api, "projectDetail").mockResolvedValue(detail(over));
  const h: Handlers = {
    onOpenPage: vi.fn(),
    onOpenFile: vi.fn(),
    onChanged: vi.fn(),
    onError: vi.fn(),
  };
  render(<ProjectPanel slug={slug} {...h} />);
  return h;
}

beforeEach(() => {
  // Thumbnails wait to be near the screen; jsdom has no such thing.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(api, "imageUrl").mockResolvedValue("blob:cat");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the project panel", () => {
  it("shows the files, pages and tables, each a way in", async () => {
    const h = open();
    await screen.findByText("Kitchen redo");
    expect(screen.getByText("plan.md")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText("5 rows")).toBeTruthy();

    fireEvent.click(screen.getByText("Kitchen board"));
    expect(h.onOpenPage).toHaveBeenCalledWith("tasks_kitchen_redo");
    fireEvent.click(screen.getByText("plan.md"));
    expect(h.onOpenFile).toHaveBeenCalledWith(`projects/${slug}/plan.md`);
    fireEvent.click(screen.getByText("Folder"));
    expect(h.onOpenFile).toHaveBeenCalledWith(`projects/${slug}`);
  });

  it("sends a picked file as base64 and re-reads the project", async () => {
    const upload = vi.spyOn(api, "uploadProjectFile").mockResolvedValue({ path: `projects/${slug}/notes.txt`, size: 5 });
    const h = open();
    await screen.findByText("Kitchen redo");
    const read = api.projectDetail as ReturnType<typeof vi.fn>;
    const before = read.mock.calls.length;

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Upload files"), { target: { files: [file] } });

    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith(slug, {
        name: "notes.txt",
        mediaType: "text/plain",
        data: btoa("hello"),
      }),
    );
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(h.onChanged).toHaveBeenCalled());
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("says which upload failed and keeps the rest", async () => {
    vi.spyOn(api, "uploadProjectFile").mockRejectedValue(new Error("big.bin is 9MB; the limit is 5MB"));
    const h = open();
    await screen.findByText("Kitchen redo");
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [new File(["x"], "big.bin")] },
    });
    await waitFor(() => expect(h.onError).toHaveBeenCalledWith("big.bin: big.bin is 9MB; the limit is 5MB"));
  });

  it("leaves out what the project has none of, and says so", async () => {
    open({ files: [], pages: [], tables: [] });
    await screen.findByText("Kitchen redo");
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
    expect(screen.getByText("No pages yet.")).toBeTruthy();
    expect(screen.getByText("No tables yet.")).toBeTruthy();
    expect(screen.queryByText("Sites")).toBeNull();
  });

  it("shows the server's sentence when the project cannot be read", async () => {
    vi.spyOn(api, "projectDetail").mockRejectedValue(new Error("project not found"));
    render(<ProjectPanel slug="nope" onOpenPage={() => {}} onOpenFile={() => {}} onChanged={() => {}} onError={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "project not found");
  });
});

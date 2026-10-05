// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type ProjectDetail } from "./api.js";
import { ProjectWorkspacePage } from "./ProjectWorkspacePage.js";

/**
 * The page is the project as a place: what works under it and what is in
 * its folder, with the two things the owner can do by hand here, start an
 * agent and put a file in, going through the API and then re-reading.
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
    agents: [
      {
        id: "c1:owner",
        userId: "owner",
        title: "Tiles",
        channel: "dashboard",
        createdAt: 1,
        updatedAt: Date.now(),
        archived: false,
        brief: "You pick tiles.",
        toolAllow: null,
        projectSlug: slug,
        kind: "chat",
        activity: "working",
      },
    ],
    files: [
      { name: "plan.md", path: `projects/${slug}/plan.md`, kind: "file", size: 2048, modifiedAt: 0 },
      { name: "cat.png", path: `projects/${slug}/cat.png`, kind: "file", size: 10, modifiedAt: 0 },
      { name: "pages", path: `projects/${slug}/pages`, kind: "dir", size: 0, modifiedAt: 0 },
    ],
    ...over,
  };
}

type Handlers = {
  onOpenChat: ReturnType<typeof vi.fn>;
  onOpenPage: ReturnType<typeof vi.fn>;
  onOpenFile: ReturnType<typeof vi.fn>;
  onChanged: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
};

function open(over: Partial<ProjectDetail> = {}): Handlers {
  vi.spyOn(api, "projectDetail").mockResolvedValue(detail(over));
  const h: Handlers = {
    onOpenChat: vi.fn(),
    onOpenPage: vi.fn(),
    onOpenFile: vi.fn(),
    onChanged: vi.fn(),
    onError: vi.fn(),
  };
  render(<ProjectWorkspacePage slug={slug} {...h} />);
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

describe("the project workspace", () => {
  it("shows the agents, files, pages and tables, each a way in", async () => {
    const h = open();
    await screen.findByText("Tiles");
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("You pick tiles.")).toBeTruthy();
    expect(screen.getByText("plan.md")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText("5 rows")).toBeTruthy();

    fireEvent.click(screen.getByText("Tiles"));
    expect(h.onOpenChat).toHaveBeenCalledWith("c1:owner");
    fireEvent.click(screen.getByText("Kitchen board"));
    expect(h.onOpenPage).toHaveBeenCalledWith("tasks_kitchen_redo");
    fireEvent.click(screen.getByText("plan.md"));
    expect(h.onOpenFile).toHaveBeenCalledWith(`projects/${slug}/plan.md`);
    fireEvent.click(screen.getByText("Folder"));
    expect(h.onOpenFile).toHaveBeenCalledWith(`projects/${slug}`);
  });

  it("opens the orchestrator chat, made on first use", async () => {
    const chat = vi.spyOn(api, "projectChat").mockResolvedValue({ id: `project:${slug}` } as never);
    const h = open();
    fireEvent.click(await screen.findByText("Open orchestrator chat"));
    await waitFor(() => expect(h.onOpenChat).toHaveBeenCalledWith(`project:${slug}`));
    expect(chat).toHaveBeenCalledWith(slug);
  });

  it("sends a picked file as base64 and re-reads the project", async () => {
    const upload = vi.spyOn(api, "uploadProjectFile").mockResolvedValue({ path: `projects/${slug}/notes.txt`, size: 5 });
    const h = open();
    await screen.findByText("Tiles");
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
    await screen.findByText("Tiles");
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [new File(["x"], "big.bin")] },
    });
    await waitFor(() => expect(h.onError).toHaveBeenCalledWith("big.bin: big.bin is 9MB; the limit is 5MB"));
  });

  it("starts an agent by hand with its brief and first task, then opens it", async () => {
    const create = vi.spyOn(api, "createProjectAgent").mockResolvedValue({ id: "c9:owner", started: true } as never);
    const h = open();
    await screen.findByText("Tiles");
    fireEvent.click(screen.getByText("New agent"));
    fireEvent.change(screen.getByPlaceholderText(/Agent name/), { target: { value: "Paint" } });
    fireEvent.change(screen.getByPlaceholderText(/Brief/), { target: { value: "You choose colours." } });
    fireEvent.change(screen.getByPlaceholderText(/First task/), { target: { value: "Pick a colour." } });
    fireEvent.click(screen.getByText("Start agent"));

    await waitFor(() => expect(h.onOpenChat).toHaveBeenCalledWith("c9:owner"));
    expect(create).toHaveBeenCalledWith(slug, {
      title: "Paint",
      brief: "You choose colours.",
      task: "Pick a colour.",
    });
    expect(h.onChanged).toHaveBeenCalled();
  });

  it("leaves out what the project has none of, and says so", async () => {
    open({ agents: [], files: [], pages: [], tables: [] });
    await screen.findByText("Kitchen redo");
    expect(screen.getByText(/No agents yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
    expect(screen.getByText("No pages yet.")).toBeTruthy();
    expect(screen.getByText("No tables yet.")).toBeTruthy();
  });

  it("shows the server's sentence when the project cannot be read", async () => {
    vi.spyOn(api, "projectDetail").mockRejectedValue(new Error("project not found"));
    render(
      <ProjectWorkspacePage
        slug="nope"
        onOpenChat={() => {}}
        onOpenPage={() => {}}
        onOpenFile={() => {}}
        onChanged={() => {}}
        onError={() => {}}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "project not found");
  });
});

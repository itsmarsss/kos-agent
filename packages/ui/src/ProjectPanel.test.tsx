// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type ProjectDetail } from "./api.js";
import { ArtifactRail } from "./ArtifactRail.js";
import { ProjectPanel } from "./ProjectPanel.js";

/**
 * The column beside a project's threads: its folder, its pages and its
 * tables, each a way in, with the Files page one explicit action away.
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
    pages: [{ id: "tasks_kitchen_redo", projectSlug: slug, title: "Kitchen board", path: "x", updatedAt: 0, kind: "spec", artifactKind: "page" }],
    crons: [],
    sites: [],
    sitesBase: null,
    migrations: [],
    activity: [],
    folder: `projects/${slug}`,
    agents: [],
    files: [],
    ...over,
  };
}

type Handlers = {
  onOpen: ReturnType<typeof vi.fn>;
  onOpenFile: ReturnType<typeof vi.fn>;
  onChanged: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
};

function open(over: Partial<ProjectDetail> = {}, files: { name: string; size: number }[] = [{ name: "plan.md", size: 2048 }]): Handlers {
  vi.spyOn(api, "projectDetail").mockResolvedValue(detail(over));
  vi.spyOn(api, "files").mockResolvedValue({
    path: `projects/${slug}`,
    entries: files.map((f) => ({ name: f.name, path: `projects/${slug}/${f.name}`, kind: "file" as const, size: f.size, modifiedAt: 0 })),
  });
  const h: Handlers = { onOpen: vi.fn(), onOpenFile: vi.fn(), onChanged: vi.fn(), onError: vi.fn() };
  const { onOpen, ...rest } = h;
  const d = detail(over);
  render(<ProjectPanel slug={slug} {...rest} rail={<ArtifactRail items={d.pages} home={slug} projects={[]} onOpen={(a) => onOpen(a.id)} />} />);
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the project panel", () => {
  it("shows the folder, pages and tables, each a way in", async () => {
    const h = open();
    await screen.findByText("Kitchen redo");
    expect(await screen.findByText("plan.md")).toBeTruthy();
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText("5 rows")).toBeTruthy();

    fireEvent.click(screen.getByText("Kitchen board"));
    expect(h.onOpen).toHaveBeenCalledWith("tasks_kitchen_redo");
    fireEvent.click(screen.getByText("Open in Files"));
    expect(h.onOpenFile).toHaveBeenCalledWith(`projects/${slug}`);
  });

  it("leaves out what the project has none of, and says so", async () => {
    open({ pages: [], tables: [] }, []);
    await screen.findByText("Kitchen redo");
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
    expect(screen.getByText(/No artifacts yet/)).toBeTruthy();
    expect(screen.getByText("No tables yet.")).toBeTruthy();
    expect(screen.queryByText("Sites")).toBeNull();
  });

  it("shows the server's sentence when the project cannot be read", async () => {
    vi.spyOn(api, "projectDetail").mockRejectedValue(new Error("project not found"));
    render(<ProjectPanel slug="nope" rail={null} onOpenFile={() => {}} onChanged={() => {}} onError={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "project not found");
  });

  it("fetches nothing while slid shut", () => {
    const read = vi.spyOn(api, "projectDetail").mockResolvedValue(detail());
    render(<ProjectPanel slug={slug} hidden rail={null} onOpenFile={() => {}} onChanged={() => {}} onError={() => {}} />);
    expect(read).not.toHaveBeenCalled();
  });
});

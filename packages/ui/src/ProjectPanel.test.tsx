// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type Conversation, type ProjectDetail } from "./api.js";
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

function open(over: Partial<ProjectDetail> = {}, files: { name: string; size: number }[] = [{ name: "plan.md", size: 2048 }], drawer?: { onClose: () => void }): Handlers {
  vi.spyOn(api, "projectDetail").mockResolvedValue(detail(over));
  vi.spyOn(api, "files").mockResolvedValue({
    path: `projects/${slug}`,
    entries: files.map((f) => ({ name: f.name, path: `projects/${slug}/${f.name}`, kind: "file" as const, size: f.size, modifiedAt: 0 })),
  });
  const h: Handlers = { onOpen: vi.fn(), onOpenFile: vi.fn(), onChanged: vi.fn(), onError: vi.fn() };
  const { onOpen, ...rest } = h;
  const d = detail(over);
  render(<ProjectPanel slug={slug} {...rest} {...(drawer ? { modal: true, onClose: drawer.onClose } : {})} rail={<ArtifactRail items={d.pages} onOpen={(a) => onOpen(a.id)} />} />);
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
    await screen.findAllByText("Kitchen redo");
    expect(await screen.findByText("plan.md")).toBeTruthy();
    expect(screen.getByText("Items")).toBeTruthy();
    expect(screen.getByText("5 rows")).toBeTruthy();

    fireEvent.click(screen.getByText("Kitchen board"));
    expect(h.onOpen).toHaveBeenCalledWith("tasks_kitchen_redo");
    fireEvent.click(screen.getByText("Open in Files"));
    expect(h.onOpenFile).toHaveBeenCalledWith(`projects/${slug}`);
  });

  it("shuts by its own × when drawn as a drawer over the chat, and has none as a column", async () => {
    const onClose = vi.fn();
    open({}, undefined, { onClose });
    await screen.findAllByText("Kitchen redo");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    cleanup();
    open();
    await screen.findAllByText("Kitchen redo");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("leaves out what the project has none of, and says so", async () => {
    open({ pages: [], tables: [] }, []);
    await screen.findAllByText("Kitchen redo");
    expect(await screen.findByText("This folder is empty.")).toBeTruthy();
    expect(screen.getByText(/No artifacts yet/)).toBeTruthy();
    expect(screen.getByText(/^No tables yet\./)).toBeTruthy();
    expect(screen.queryByText("Sites")).toBeNull();
  });

  it("counts what it holds as the projects list does, each figure in its number's words, and goes to its section", async () => {
    const thread = (id: string, over: Partial<Conversation>): Conversation => ({ id, projectSlug: slug, kind: "chat", archived: false, ...over }) as Conversation;
    open({
      agents: [thread("a", {}), thread("b", {}), thread("old", { archived: true }), thread("job", { kind: "schedule" })],
      crons: [{ id: 1, name: "kitchen.remind", schedule: "0 9 * * *", type: "self_prompt", enabled: true }],
    });
    const figures = await screen.findByRole("list", { name: "What it holds" });
    expect([...figures.querySelectorAll(".project-stat")].map((f) => f.textContent)).toEqual(["2Agents", "1Artifact", "1Table", "1Schedule"]);
    // Agents and jobs are the rail's, beside the chat; artifacts and tables are here.
    expect(within(figures).getAllByRole("button").map((b) => b.textContent)).toEqual(["1Artifact", "1Table"]);
    fireEvent.click(within(figures).getByRole("button", { name: "1Table" }));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Tables" }));
  });

  it("shows the server's sentence when the project cannot be read", async () => {
    vi.spyOn(api, "projectDetail").mockRejectedValue(new Error("project not found"));
    render(<ProjectPanel slug="nope" rail={null} onOpenFile={() => {}} onChanged={() => {}} onError={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "project not found");
  });

  it("fetches nothing while slid shut, and is out of the tab order", () => {
    const read = vi.spyOn(api, "projectDetail").mockResolvedValue(detail());
    render(<ProjectPanel slug={slug} hidden rail={null} onOpenFile={() => {}} onChanged={() => {}} onError={() => {}} />);
    expect(read).not.toHaveBeenCalled();
    expect(document.querySelector("aside.project-panel")?.hasAttribute("inert")).toBe(true);
  });

  it("is in reach once open", async () => {
    vi.spyOn(api, "projectDetail").mockResolvedValue(detail());
    render(<ProjectPanel slug={slug} rail={null} onOpenFile={() => {}} onChanged={() => {}} onError={() => {}} />);
    await screen.findByText("Open in Files");
    expect(document.querySelector("aside.project-panel")?.hasAttribute("inert")).toBe(false);
  });
});

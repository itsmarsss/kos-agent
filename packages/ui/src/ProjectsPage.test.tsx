// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type Conversation, type CronJob, type PageSummary, type Project, type ProjectDetail } from "./api.js";
import { ProjectsPage } from "./ProjectsPage.js";

beforeAll(() => {
  window.matchMedia ??= (() => ({ addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const now = Date.now();
const PROJECTS: Project[] = [
  { slug: "garden", name: "Garden", type: "tracker", status: "active", description: "What grows where, and when to water it.", lastTouchedAt: now - 3 * 86_400_000 },
  { slug: "budget", name: "Household budget", type: "budget", status: "active", lastTouchedAt: now - 60_000 },
  { slug: "old", name: "Old notes", type: "notes", status: "archived", lastTouchedAt: now - 30 * 86_400_000 },
];
const chat = (id: string, projectSlug: string, over: Partial<Conversation> = {}): Conversation =>
  ({ id, userId: "o", title: id, channel: null, createdAt: 0, updatedAt: now - 7 * 86_400_000, archived: false, brief: null, toolAllow: null, projectSlug, kind: "chat", ...over }) as Conversation;
const page = (id: string, projectSlug: string, over: Partial<PageSummary> = {}): PageSummary => ({ id, projectSlug, title: id, path: "", updatedAt: 0, kind: "html", artifactKind: "doc", ...over });

beforeEach(() => {
  vi.spyOn(api, "projectDetail").mockImplementation((slug) => Promise.resolve({ tables: slug === "garden" ? [{ name: "beds", rows: 3, columns: 2 }, { name: "plants", rows: 9, columns: 4 }] : [] } as unknown as ProjectDetail));
  vi.spyOn(api, "health").mockResolvedValue({ ok: false, failing: [{ key: "cron:7", label: "garden.water", streak: 2, error: "the pump is offline", since: 0, lastAt: 0 }], recent: { total: 0, errors: 0, rate: 0 } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(over: Partial<Parameters<typeof ProjectsPage>[0]> = {}): { onOpen: ReturnType<typeof vi.fn>; onInspect: ReturnType<typeof vi.fn> } {
  const onOpen = vi.fn();
  const onInspect = vi.fn();
  render(
    <ProjectsPage
      projects={PROJECTS}
      pagesByProject={new Map([["garden", [page("plan", "garden"), page("gone", "garden", { trashedAt: now })]]])}
      conversations={[chat("a1", "garden"), chat("a2", "garden"), chat("b1", "budget", { activity: "needs-you" })]}
      crons={[{ id: 7, name: "garden.water", schedule: "0 7 * * *", type: "self_prompt", enabled: true, projectSlug: "garden" } as CronJob]}
      onOpen={onOpen}
      onInspect={onInspect}
      {...over}
    />,
  );
  return { onOpen, onInspect };
}

const card = (name: string): HTMLElement => screen.getByRole("button", { name: `Open ${name}` });
const order = (): string[] => [...document.querySelectorAll(".project-card .card-name")].map((n) => n.textContent ?? "");

describe("the Projects page", () => {
  it("says what each holds, what is for, and when it last moved, the trash left out", async () => {
    show();
    const garden = card("Garden");
    expect(within(garden).getByText("What grows where, and when to water it.")).toBeTruthy();
    expect(within(garden).getByText("tracker")).toBeTruthy();
    await waitFor(() => expect(within(garden).getByText("2 agents · 2 tables · 1 artifact")).toBeTruthy());
    expect(within(card("Household budget")).getByText("1 agent")).toBeTruthy();
    expect(within(card("Old notes")).getByText("Nothing in it yet")).toBeTruthy();
    expect(within(garden).getByTitle("Last activity").textContent).toBe("3 days ago");
  });

  it("flags what wants the owner: a failing job, then a chat waiting on them", async () => {
    show();
    const failing = await within(card("Garden")).findByText("Job failing");
    expect(failing.getAttribute("title")).toBe("garden.water: the pump is offline");
    expect(within(card("Household budget")).getByText("Needs you")).toBeTruthy();
    // A state worth saying only when it is not the usual one.
    expect(within(card("Old notes")).getByText("archived")).toBeTruthy();
  });

  it("groups by state only when there is more than one, newest first or by name, and searches", () => {
    show();
    expect(screen.getByRole("region", { name: "active" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "archived" })).toBeTruthy();
    expect(order()).toEqual(["Household budget", "Garden", "Old notes"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    fireEvent.click(screen.getByRole("option", { name: "Name" }));
    expect(order()).toEqual(["Garden", "Household budget", "Old notes"]);
    fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "water" } });
    expect(order()).toEqual(["Garden"]);
    expect(screen.queryByRole("region", { name: "archived" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "zebra" } });
    expect(screen.getByText("No project matches “zebra”.")).toBeTruthy();
  });

  it("opens a project from its card, by pointer or key, and its drawer from Details", () => {
    const { onOpen, onInspect } = show();
    fireEvent.click(card("Garden"));
    expect(onOpen).toHaveBeenCalledWith("garden");
    fireEvent.keyDown(card("Household budget"), { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("budget");
    fireEvent.click(screen.getByRole("button", { name: "Details of Garden" }));
    expect(onInspect).toHaveBeenCalledWith(PROJECTS[0], expect.any(Array));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("says plainly when there are none, with the way to make one", () => {
    show({ projects: [], onCreate: () => Promise.resolve() });
    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
  });
});

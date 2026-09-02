// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { Inspector } from "./Inspector.js";

/**
 * The project drawer was a flat stack of nine equally-weighted sections with
 * every value pushed to the far edge of a 720px panel. These cover what the
 * redesign is actually for: contents first, metadata quiet, and nothing shown
 * that says the same thing twice.
 */

const project = {
  slug: "kitchen_redo",
  name: "Kitchen redo",
  type: "tasks",
  status: "active",
  module: "tasks",
  description: "Everything for the kitchen.",
  createdAt: 1_700_000_000_000,
  lastTouchedAt: 1_700_000_000_000,
};

function detail(over: Record<string, unknown> = {}): unknown {
  return {
    project,
    tables: [{ name: "items", rows: 5, columns: 4 }],
    pages: [{ id: "tasks_kitchen_redo", title: "Kitchen redo" }],
    crons: [],
    sites: [],
    sitesBase: null,
    migrations: [],
    activity: [],
    folder: "projects/kitchen_redo",
    ...over,
  };
}

function open(over: Record<string, unknown> = {}): void {
  vi.spyOn(api, "projectDetail").mockResolvedValue(detail(over) as never);
  render(
    <Inspector
      target={{ kind: "project", data: project as never, pages: [] }}
      onClose={() => {}}
    />,
  );
}

/** Section headings only: "Pages" is also a stat label in the summary strip. */
function sections(): string[] {
  return [...document.querySelectorAll("h3.insp-label")].map(
    (h) => h.textContent ?? "",
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the project drawer", () => {
  it("leads with what is in the project", async () => {
    open();
    await waitFor(() => expect(sections()).toContain("Data"));
    expect(screen.getByText("items")).toBeTruthy();
    expect(screen.getByText(/5 rows/)).toBeTruthy();
    expect(sections()).toContain("Pages");
  });

  it("does not show a section for something the project has none of", async () => {
    open();
    await waitFor(() => expect(sections()).toContain("Data"));
    // Empty Sites, Schedules and Schema headings were rendered regardless,
    // so a small project read as a page of blanks.
    expect(sections()).not.toContain("Sites");
    expect(sections()).not.toContain("Schedules");
    expect(sections()).not.toContain("Schema");
  });

  it("says what has been done to it lately", async () => {
    open({
      activity: [
        {
          id: 1,
          tool: "files.write",
          args: '{"path":"projects/kitchen_redo/notes.md"}',
          result: "",
          isError: false,
          createdAt: Date.now() - 3_600_000,
        },
      ],
    });
    await waitFor(() => expect(sections()).toContain("Recent"));
    expect(screen.getByText("files.write")).toBeTruthy();
    expect(screen.getByText("1h ago")).toBeTruthy();
  });

  it("does not print the same date twice", async () => {
    open();
    await waitFor(() => expect(sections()).toContain("About"));
    // Created and last touched were both rendered in full, to the second,
    // for a project that had never been modified.
    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.queryByText("Last touched")).toBeNull();
  });

  it("shows last touched once it means something", async () => {
    const moved = { ...project, lastTouchedAt: project.createdAt + 86_400_000 };
    vi.spyOn(api, "projectDetail").mockResolvedValue(
      detail({ project: moved }) as never,
    );
    render(
      <Inspector
        target={{ kind: "project", data: moved as never, pages: [] }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("Last touched")).toBeTruthy());
  });

  it("shows the status it was just given, not the one it was opened with", async () => {
    // The header is built from the object the card handed over, which does
    // not change when the drawer saves, so it went on saying "active".
    open();
    await waitFor(() => expect(sections()).toContain("About"));
    expect(screen.getByText(/kitchen_redo · active/)).toBeTruthy();
  });

  it("still shows the panel when the detail fetch fails", async () => {
    vi.spyOn(api, "projectDetail").mockRejectedValue(new Error("nope"));
    render(
      <Inspector
        target={{ kind: "project", data: project as never, pages: [] }}
        onClose={() => {}}
      />,
    );
    // The card already knew the name; losing the extra detail should not
    // cost the owner the drawer.
    expect(screen.getByText("Kitchen redo")).toBeTruthy();
    expect(screen.getByText("Everything for the kitchen.")).toBeTruthy();
  });
});

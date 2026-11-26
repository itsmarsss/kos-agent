// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type CronJob } from "./api.js";
import { allowedWords, Inspector, madeIn } from "./Inspector.js";

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
  return [...document.querySelectorAll(".insp-section .card-title")].map(
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
    // By what it did and to what; the tool's name is only the row's tooltip.
    expect(screen.getByText("Write a file")).toBeTruthy();
    expect(screen.getByText("projects/kitchen_redo/notes.md")).toBeTruthy();
    expect(screen.queryByText("files.write")).toBeNull();
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
    expect(document.querySelector(".insp-hero-meta .pill")?.textContent).toBe("Active");
    // Its slug is an id: for a tooltip, never a tag on the page.
    expect(screen.queryByText("kitchen_redo")).toBeNull();
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

describe("a failed step's drawer", () => {
  it("leads with what went wrong in words, keeps the machinery under Details, and says Fix opens a chat", () => {
    vi.spyOn(api, "call").mockRejectedValue(new Error("offline"));
    const onFix = vi.fn();
    render(
      <Inspector
        target={{
          kind: "tool",
          data: { id: 7, tool: "files.read", args: '{"path":"notes/missing-file.md"}', result: "tool error: ENOENT: no such file or directory, open '/Users/me/kos-workspace/notes/missing-file.md'", isError: true, riskTier: "safe", userId: "owner", createdAt: Date.now() },
        }}
        onFix={onFix}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Read a file")).toBeTruthy();
    expect(screen.getByText("There is no file or folder called “missing-file.md”.")).toBeTruthy();
    expect(screen.queryByText(/Tool call #7/)).toBeNull();
    const details = document.querySelector("details.insp-details")!;
    expect(details.hasAttribute("open")).toBe(false);
    // The raw words, the arguments and the risk are in the fold, not the headline.
    expect(details.textContent).toContain("ENOENT");
    expect(details.textContent).toContain("files.read");
    const lead = document.querySelector(".insp-lead")!.textContent ?? "";
    expect(lead).not.toMatch(/ENOENT|\/Users\//);
    const fix = screen.getByRole("button", { name: "Fix in a chat" });
    expect(fix.getAttribute("title")).toMatch(/Opens a chat/);
  });

  it("names a schedule's missing file from the workspace down, and says a schedule made the step", () => {
    vi.spyOn(api, "call").mockRejectedValue(new Error("offline"));
    render(
      <Inspector
        workspace="/Users/me/kos-workspace"
        target={{
          kind: "tool",
          data: { id: 8, tool: "files.read", args: '{"path":"notes/todo.md"}', result: "ENOENT: no such file or directory, open '/Users/me/kos-workspace/blobs/recap/notes/todo.md'", isError: true, riskTier: "safe", userId: "owner", conversationId: "agent:recap", createdAt: Date.now() },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("There is no file or folder at “blobs/recap/notes/todo.md”.")).toBeTruthy();
    expect(document.querySelector("details.insp-details")!.textContent).toContain("Recap, a blob");
    expect(screen.queryByText("You")).toBeNull();
  });
});

describe("who let a risky step run", () => {
  it("says the ask's place and number, a rule or Auto, and unknown for a step from before", () => {
    const at = Date.now();
    expect(allowedWords({ decidedVia: "discord", approvalId: 742, createdAt: at })).toMatch(/^Approved on Discord, .+, #742$/);
    expect(allowedWords({ decidedVia: "cli", approvalId: 743, createdAt: at })).toMatch(/^Approved on the command line, .+, #743$/);
    expect(allowedWords({ decidedVia: "rule", approvalId: null, createdAt: at })).toMatch(/^Approved by a remembered rule, /);
    expect(allowedWords({ decidedVia: null, approvalId: null, createdAt: at })).toMatch(/; where is unknown$/);
  });

  it("is said in a risky step's drawer", () => {
    vi.spyOn(api, "call").mockRejectedValue(new Error("offline"));
    render(<Inspector target={{ kind: "tool", data: { id: 9, tool: "sql", args: "{}", result: "", isError: false, riskTier: "risky", decidedVia: "phone", approvalId: 12, createdAt: Date.now() } }} onClose={() => {}} />);
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByText(/^Approved on KOS for iPhone, .+, #12$/)).toBeTruthy();
  });

  it("says a yes given on the command line as the command line's", () => {
    vi.spyOn(api, "call").mockRejectedValue(new Error("offline"));
    render(<Inspector target={{ kind: "tool", data: { id: 10, tool: "sql", args: "{}", result: "", isError: false, riskTier: "risky", decidedVia: "cli", approvalId: 13, createdAt: Date.now() } }} onClose={() => {}} />);
    expect(screen.getByText(/^Approved on the command line, .+, #13$/)).toBeTruthy();
  });
});

describe("where a step was made", () => {
  it("says a schedule, a blob or a chat, never the owner for a schedule's step", () => {
    expect([madeIn("cron:3"), madeIn("agent:plant-watcher"), madeIn("c-1"), madeIn(null)]).toEqual(["A schedule's run", "Plant watcher, a blob", "A chat", "—"]);
  });
});

describe("a run in the drawer", () => {
  it("opens the chat a schedule's run was written into, beside the fix for a failed one", () => {
    const opened: string[] = [];
    const crons = [{ id: 28, name: "School Morning Digest", schedule: "32 7 * * *", type: "self_prompt", enabled: true, conversationId: "cron:28" }] as CronJob[];
    render(
      <Inspector
        target={{ kind: "run", data: { id: 4083, kind: "cron", ref: "28", status: "interrupted", error: "KOS restarted while it was running.", startedAt: Date.now() } }}
        onClose={() => {}}
        crons={crons}
        chats={new Set(["cron:28"])}
        onOpenChat={(id) => opened.push(id)}
        onFix={() => {}}
      />,
    );
    // Cut short is failed: it can be fixed, and read.
    expect(screen.getByRole("button", { name: "Fix in a chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open its chat" }));
    expect(opened).toEqual(["cron:28"]);
  });
});

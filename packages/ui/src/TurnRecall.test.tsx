// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { TurnRecall as Recall } from "./api.js";
import { claimTitle, groupRecall, TurnRecall } from "./TurnRecall.js";

afterEach(cleanup);
// jsdom has no ResizeObserver; the panel's body watches its height with one, for its fades and its scrollbar.
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
});

type Fact = Recall["facts"][number];

const fact = (id: number, key: string, value: string, more: Partial<Fact> = {}): Fact => ({ id, key, value, scope: "global", pinned: false, trust: "owner", ...more });

const school: Recall = {
  at: 1,
  projectSlug: "school",
  facts: [
    fact(1, "name", "Sam", { pinned: true }),
    fact(2, "mef_calhacks_purchase", "Bought the MEF kit for CalHacks with the club card; the receipt is in the treasurer folder and needs filing before the reimbursement deadline.", { scope: "project:school", trust: "agent" }),
    fact(3, "timezone", "America/Toronto"),
    fact(4, "note_3", "Office hours moved to Thursday. Bring the lab report.", { scope: "project:school" }),
  ],
  events: [{ id: 9, role: "owner", text: "we moved the tea", ts: Date.now() - 3 * 3600_000 }],
};

const open = (recalled: Recall): HTMLElement => {
  render(<TurnRecall recalled={recalled} />);
  fireEvent.click(screen.getByRole("button", { name: /^Memory:/ }));
  return screen.getByRole("dialog");
};

const many = (n: number): Recall => ({ at: 1, projectSlug: null, facts: Array.from({ length: n }, (_, i) => fact(i + 1, `topic_${"abcdefghij"[i]}`, `claim ${i + 1}`)), events: [] });

describe("a claim's title", () => {
  it("reads the key in words, cased as the claim writes them", () => {
    expect(claimTitle("mef_calhacks_purchase", "Bought the MEF kit for CalHacks.").title).toBe("MEF CalHacks purchase");
    expect(claimTitle("deployTarget", "Deploys go to fly.io").title).toBe("Deploy target");
    expect(claimTitle("cs341_midterm", "On December 4.").title).toBe("CS341 midterm");
  });

  it("does not take a capital that only starts a sentence", () => {
    expect(claimTitle("purchase_date", "Purchase was made on Monday.").title).toBe("Purchase date");
  });

  it("is the first sentence when the key names nothing, the rest the body", () => {
    expect(claimTitle("https://example.com/a/b", "The course outline. It has the late policy.").title).toBe("The course outline.");
    expect(claimTitle("note_9", "Moved the\nmeeting. To Friday.")).toEqual({ title: "Moved the\nmeeting.", body: "To Friday." });
    expect(claimTitle("note_3", "Office hours moved to Thursday. Bring the lab report.")).toEqual({ title: "Office hours moved to Thursday.", body: "Bring the lab report." });
  });
});

describe("what the last turn was given from memory", () => {
  it("counts in the chip and opens on a press", () => {
    render(<TurnRecall recalled={school} />);
    const chip = screen.getByRole("button", { name: /^Memory:/ });
    expect(chip.textContent).toBe("4 claims · 1 log entry");
    expect(chip.getAttribute("aria-label")).toBe("Memory: 4 claims · 1 log entry");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "What KOS remembered for this turn" });
    expect(within(dialog).getByText("4 claims · 1 log entry")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: /school/ }).getAttribute("href")).toBe("#/project/school");
    expect(within(dialog).getByRole("link", { name: "Open in Memory" }).getAttribute("href")).toBe("#/memory?tab=claims&ids=1,2,3,4");
  });

  it("groups pinned first, then the project, everywhere and the moments", () => {
    expect(groupRecall(school).map((g) => [g.label, g.items.length])).toEqual([
      ["Pinned", 1],
      ["This project", 2],
      ["Everywhere", 1],
      ["Log", 1],
    ]);
    const dialog = open(school);
    const heads = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(heads).toEqual(["Pinned 1in every turn", "This project 2", "Everywhere 1", "Log 1what was said, close to the last message"]);
  });

  it("names a pinned claim's scope and every claim's source as tags", () => {
    const dialog = open(school);
    const pinned = within(dialog).getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByText("everywhere")).toBeTruthy();
    expect(within(pinned).getByTitle("Pinned: in every turn")).toBeTruthy();
    const project = within(dialog).getByRole("region", { name: "This project" });
    expect(within(project).queryByText("project school")).toBeNull();
    expect(within(project).getByText("from KOS").getAttribute("title")).toBe("KOS worked this out");
  });

  it("gives another scope a group of its own", () => {
    const groups = groupRecall({ ...school, facts: [...school.facts, fact(5, "deploy", "fly", { scope: "caller:ci" })] });
    expect(groups.map((g) => g.label)).toEqual(["Pinned", "This project", "Everywhere", "The app ci", "Log"]);
  });

  it("clamps a claim's words until it is opened, then shows them whole with its key", () => {
    const dialog = open(school);
    const row = within(dialog).getByRole("button", { name: /MEF CalHacks purchase/ });
    const item = row.closest("li")!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(item.classList.contains("is-open")).toBe(false);
    expect(within(item).queryByText("mef_calhacks_purchase")).toBeNull();
    // The words are not part of the toggle, so they can be selected.
    expect(row.contains(within(item).getByText(/Bought the MEF kit/))).toBe(false);
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(item.classList.contains("is-open")).toBe(true);
    expect(within(item).getByText("mef_calhacks_purchase")).toBeTruthy();
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers a filter only past a handful, and filters by words", () => {
    expect(within(open(many(6))).queryByRole("searchbox")).toBeNull();
    cleanup();
    const dialog = open(many(8));
    const find = within(dialog).getByRole("searchbox", { name: "Filter what was remembered" });
    fireEvent.change(find, { target: { value: "claim 7" } });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);
    expect(within(dialog).getByText("claim 7")).toBeTruthy();
  });

  it("says when the filter matches nothing, and clears it", () => {
    const dialog = open(many(8));
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "zebra" } });
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(dialog).getByText(/Nothing here matches “zebra”/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear the filter" }));
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(8);
  });

  it("moves with the arrows from the filter through the rows, and Escape closes it", () => {
    const dialog = open(many(8));
    const find = within(dialog).getByRole("searchbox");
    expect(document.activeElement).toBe(find);
    const rows = within(dialog).getAllByRole("button", { name: /^Topic/ });
    fireEvent.keyDown(find, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "End" });
    expect(document.activeElement).toBe(rows.at(-1));
    fireEvent.keyDown(rows.at(-1)!, { key: "Home" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(find);
    fireEvent.keyDown(find, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Memory:/ }));
  });

  it("sends only moments to the Memory page's log", () => {
    const dialog = open({ at: 1, projectSlug: null, facts: [], events: school.events });
    expect(within(dialog).getByRole("link", { name: "Open in Memory" }).getAttribute("href")).toBe("#/memory?tab=log");
    expect(within(dialog).getByText("You said")).toBeTruthy();
    expect(within(dialog).getByText("3h ago")).toBeTruthy();
  });

  it("sits over the composer it is in, shorter when there is little room, inside the window", () => {
    const at = (top: number, left: number): DOMRect => ({ top, left, bottom: top + 20, right: left + 120, width: 120, height: 20, x: left, y: top, toJSON: () => ({}) });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("composer-box") ? at(300, 100) : at(380, 1200);
    });
    try {
      render(
        <div className="composer-box">
          <TurnRecall recalled={school} />
        </div>,
      );
      fireEvent.click(screen.getByRole("button", { name: /^Memory:/ }));
      const { style } = screen.getByRole("dialog");
      expect(style.getPropertyValue("--recall-y")).toBe(`${window.innerHeight - 300 + 8}px`);
      expect(style.getPropertyValue("--recall-h")).toBe("284px");
      expect(style.getPropertyValue("--recall-x")).toBe(`${window.innerWidth - 560 - 8}px`);
    } finally {
      rect.mockRestore();
    }
  });

  it("closes when the focus leaves it on a desktop", () => {
    render(
      <>
        <TurnRecall recalled={school} />
        <button type="button">elsewhere</button>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Memory:/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    fireEvent.blur(within(dialog).getAllByRole("button", { name: /Owner|Name/ })[0]!, { relatedTarget: screen.getByRole("button", { name: /^Memory:/ }) });
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.blur(dialog, { relatedTarget: screen.getByRole("button", { name: "elsewhere" }) });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a modal sheet on a phone, its focus on the first row rather than the filter", () => {
    const matchMedia = vi.fn((q: string) => ({ matches: q === "(max-width: 640px)" }));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const dialog = open(many(8));
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement).toBe(within(dialog).getAllByRole("button", { name: /^Topic/ })[0]);
      fireEvent.blur(dialog, { relatedTarget: document.body });
      expect(screen.queryByRole("dialog")).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    }
  });

  it("shuts when the next turn's memory comes, and says nothing of a lost time", () => {
    const { rerender } = render(<TurnRecall recalled={school} />);
    fireEvent.click(screen.getByRole("button", { name: /^Memory:/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    rerender(<TurnRecall recalled={{ at: 2, projectSlug: null, facts: [], events: [] }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<TurnRecall recalled={{ at: 3, projectSlug: null, facts: [], events: [{ id: 1, role: "owner", text: "hi", ts: Number.NaN }] }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Memory:/ }));
    expect(screen.getByRole("dialog").querySelector("time")).toBeNull();
    expect(screen.getByText("You said")).toBeTruthy();
  });

  it("says so when nothing matched", () => {
    render(<TurnRecall recalled={{ at: 1, projectSlug: null, facts: [], events: [] }} />);
    expect(screen.getByText("nothing matched")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

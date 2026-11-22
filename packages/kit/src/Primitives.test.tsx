// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyState, noMatchWords } from "./EmptyState.js";
import { StatusPill } from "./kit.js";
import { GroupHead, ListHead, NotFound, PaneHead, SearchField, TableGroup, TableHead } from "./PageParts.js";
import { PlacePicker, type Place } from "./PlacePicker.js";
import { SheetFoot, SheetHead } from "./Sheet.js";
import { When } from "./When.js";

afterEach(cleanup);

describe("EmptyState", () => {
  it("says a page's empty list in a box with its title, and a card's in a line", () => {
    const { container, rerender } = render(<EmptyState title="Nothing running">KOS starts one when it needs to.</EmptyState>);
    expect(container.querySelector(".empty .empty-title")?.textContent).toBe("Nothing running");
    rerender(<EmptyState variant="inline">No tables yet.</EmptyState>);
    expect(container.querySelector("p.empty-line")?.textContent).toBe("No tables yet.");
  });

  it("answers a search that found nothing in the same words, with one Clear filters", () => {
    const onClear = vi.fn();
    const { container } = render(<EmptyState query={{ noun: "claims", onClear }}>Nothing remembered yet.</EmptyState>);
    expect(container.textContent).toContain(noMatchWords("claims").title);
    expect(container.textContent).toContain("No claims match these words and filters.");
    expect(container.textContent).not.toContain("Nothing remembered yet.");
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("is a table's one row across its columns", () => {
    const { container } = render(
      <table>
        <tbody>
          <EmptyState variant="row" columns={4} query={{ noun: "runs" }} />
        </tbody>
      </table>,
    );
    expect(container.querySelector("tr.empty-row td")?.getAttribute("colspan")).toBe("4");
    expect(container.textContent).toBe("No runs match these words and filters.");
  });
});

describe("StatusPill", () => {
  it("draws a state in its one word and tone", () => {
    const { container, rerender } = render(<StatusPill state="off" />);
    expect(container.querySelector(".pill--muted")?.textContent).toBe("Off");
    rerender(<StatusPill state="failed" />);
    expect(container.querySelector(".pill--danger")?.textContent).toBe("Failed");
    rerender(<StatusPill state="idle" />);
    expect(container.querySelector(".pill--muted")?.textContent).toBe("Quiet");
  });
});

describe("When", () => {
  it("says a moment in the short words, the clock time on hover, and is no link", () => {
    const now = Date.UTC(2026, 10, 22, 12);
    const { container } = render(<When at={now - 6 * 60_000} now={now} />);
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("6m ago");
    expect(time.getAttribute("title")).toBeTruthy();
    expect(container.querySelector("a, button")).toBeNull();
  });
});

describe("SheetHead and SheetFoot", () => {
  it("close by an × and keep Cancel secondary, the primary last, a danger far left", () => {
    const onClose = vi.fn();
    render(<SheetHead title="New schedule" subtitle="Runs on its own" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    const { container } = render(
      <SheetFoot
        onCancel={() => {}}
        danger={<button className="btn btn--danger">Delete</button>}
        primary={<button className="btn btn--primary">Save</button>}
      />,
    );
    const buttons = [...container.querySelectorAll(".sheet-foot button")].map((b) => [b.textContent, b.className]);
    expect(buttons).toEqual([
      ["Delete", "btn btn--danger"],
      ["Cancel", "btn"],
      ["Save", "btn btn--primary"],
    ]);
  });
});

describe("SearchField", () => {
  it("says Search and the noun, clears by its × or Escape", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchField value="" onChange={onChange} noun="projects" />);
    const input = screen.getByPlaceholderText("Search projects");
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    rerender(<SearchField value="zz" onChange={onChange} noun="projects" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange.mock.calls).toEqual([[""], [""]]);
  });
});

describe("NotFound", () => {
  it("names what was asked for and the way back, never the server's words", () => {
    render(<NotFound what="project" name="nope" back={{ label: "All projects", href: "#/projects" }} />);
    expect(screen.getByRole("status").textContent).toContain("No project called “nope”");
    expect(screen.getByRole("link", { name: "All projects" }).getAttribute("href")).toBe("#/projects");
  });
});

describe("GroupHead and the table's head", () => {
  it("head a group with its count, and a table in one style", () => {
    const { container } = render(<GroupHead title="Approvals" count={2} />);
    expect(container.querySelector("h2.group-title")?.textContent).toBe("Approvals2");
    const table = render(
      <table>
        <TableHead columns={[{ label: "What" }, { label: "When", align: "end" }]} />
        <tbody>
          <TableGroup title="Today" columns={2} />
        </tbody>
      </table>,
    );
    expect([...table.container.querySelectorAll(".table-head th")].map((th) => th.className)).toEqual(["", "is-end"]);
    expect(table.container.querySelector(".table-group th")?.getAttribute("colspan")).toBe("2");
    const list = render(<ListHead columns={[{ label: "Outcome", width: "5rem" }, { label: "What" }]} />);
    expect([...list.container.querySelectorAll(".table-head-cell")].map((c) => c.textContent)).toEqual(["Outcome", "What"]);
  });
});

describe("PlacePicker", () => {
  const places: Place[] = [
    { id: "ws", name: "Workspace", group: "workspace" },
    { id: "p:reading_log", name: "Reading log", group: "project" },
    { id: "b:plant-watcher", name: "Plant watcher", group: "blob" },
  ];

  it("groups places by kind under one head each, names not slugs, and marks where it is now", () => {
    const onChoose = vi.fn();
    const { container } = render(<PlacePicker places={places} current="ws" value={null} onChoose={onChoose} />);
    expect([...container.querySelectorAll(".place-group-head")].map((h) => h.textContent)).toEqual(["Projects", "Blobs"]);
    const here = screen.getByRole("radio", { name: /Workspace/ });
    expect(here.hasAttribute("disabled")).toBe(true);
    expect(here.textContent).toContain("Here now");
    fireEvent.click(screen.getByRole("radio", { name: /Plant watcher/ }));
    expect(onChoose).toHaveBeenCalledWith("b:plant-watcher");
  });

  it("walks the places it offers by the arrows, and searches a long list", () => {
    const onChoose = vi.fn();
    const many: Place[] = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `Place ${i}`, group: "project" }));
    render(<PlacePicker places={many} current="p0" value="p1" onChoose={onChoose} />);
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowDown" });
    expect(onChoose).toHaveBeenLastCalledWith("p2");
    fireEvent.change(screen.getByPlaceholderText("Search places"), { target: { value: "Place 9" } });
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Place 9"]);
  });
});

describe("PaneHead", () => {
  it("heads a project's pane and a blob's alike: mark, name over kind, state, what it is for", () => {
    const { container } = render(<PaneHead mark={<span>R</span>} title="Reading log" sub="Project" pill={<StatusPill state="active" />} desc="Books, read and to read." />);
    expect(container.querySelector(".pane-head h2")?.textContent).toBe("Reading log");
    expect(container.querySelector(".pane-head-sub")?.textContent).toBe("Project");
    expect(container.querySelector(".pane-head-top .pill")?.textContent).toBe("Active");
    expect(container.querySelector(".pane-head-desc")?.textContent).toBe("Books, read and to read.");
  });
});

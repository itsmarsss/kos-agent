// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api, type FactRow } from "./api.js";
import { useState, type ReactElement } from "react";
import { SearchField } from "@kos/kit";

import { groupByScope, KnowledgePage, SCOPE_FIRST, type KnowledgePageProps } from "./KnowledgePage.js";

/** The page as the Memory page holds it: the new-claim form open or shut, and the head's search. */
function Claims(props: Omit<KnowledgePageProps, "adding" | "onAdding" | "query" | "onQuery">): ReactElement {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  return (
    <>
      <SearchField value={query} onChange={setQuery} noun="claims" />
      <KnowledgePage {...props} adding={adding} onAdding={setAdding} query={query} onQuery={setQuery} />
    </>
  );
}

// jsdom has no ResizeObserver; rows that scroll sideways watch their width with one.
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
});
const fact = (over: Partial<FactRow> = {}): FactRow => ({
  key: "monthly_budget",
  value: "1200 a month",
  kind: "fact",
  source: "dashboard",
  tags: ["budget", "finance"],
  pinned: false,
  updatedAt: 1,
  ...over,
});

describe("KnowledgePage", () => {
  afterEach(cleanup);

  it("lists an entry once however many tags it carries", () => {
    // Grouping put the entry under every one of its tags, so one saved fact
    // read as two, each apparently a separate thing the agent believed.
    render(
      <Claims
        facts={[fact()]}
        tags={["budget", "finance"]}
        onChanged={() => undefined}
      />,
    );
    expect(screen.getAllByText("Monthly budget")).toHaveLength(1);
  });

  it("still shows every tag on the entry itself", () => {
    render(
      <Claims
        facts={[fact()]}
        tags={["budget", "finance"]}
        onChanged={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain("budget, finance");
  });
});

describe("the claims list", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const many = (n: number, over: Partial<FactRow> = {}): FactRow[] =>
    Array.from({ length: n }, (_, i) => fact({ key: `k${i}`, value: `value ${i}`, updatedAt: 1000 - i, ...over }));

  it("groups by where a claim applies: everywhere, projects by name, then blobs", () => {
    const groups = groupByScope(
      [
        fact({ key: "a", scope: "project:trip" }),
        fact({ key: "b", scope: "agent:verity" }),
        fact({ key: "c", scope: "global" }),
        fact({ key: "d", scope: "project:blob:verity" }),
        fact({ key: "e", scope: "project:trip", pinned: true }),
      ],
      new Map([["trip", "Lisbon trip"]]),
    );
    expect(groups.map((g) => [g.title, g.kind])).toEqual([
      ["Everywhere", null],
      ["Lisbon trip", "Project"],
      ["Verity", "Blob"],
    ]);
    expect(groups[1]).toMatchObject({ project: "trip" });
    // A project scope with no project behind it says so, under its slug.
    expect(groupByScope([fact({ scope: "project:gone" })], new Map())[0]).toMatchObject({ title: "gone", kind: "No such project", unknown: true });
    // Before the manifest is read, nothing is called missing.
    expect(groupByScope([fact({ scope: "project:trip" })])[0]).toMatchObject({ title: "Trip", kind: "Project" });
    expect(groupByScope([fact({ scope: "project:trip" })])[0]!.unknown).toBeUndefined();
    // A slug written with its prefix twice is the same project.
    const twice = groupByScope([fact({ key: "x", scope: "project:project:trip" }), fact({ key: "y", scope: "project:trip" })], new Map([["trip", "Lisbon trip"]]));
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ title: "Lisbon trip", project: "trip" });
    expect(twice[0]!.facts).toHaveLength(2);
    // Pinned leads its scope; a blob's two names are one place.
    expect(groups[1]!.facts.map((f) => f.key)).toEqual(["e", "a"]);
    expect(groups[2]!.facts).toHaveLength(2);
  });

  it("shows a scope's first few, the rest a press away", () => {
    render(<Claims facts={many(SCOPE_FIRST + 4)} tags={[]} onChanged={() => undefined} />);
    expect(document.querySelectorAll(".know-row")).toHaveLength(SCOPE_FIRST);
    fireEvent.click(screen.getByRole("button", { name: `Show all ${SCOPE_FIRST + 4}` }));
    expect(document.querySelectorAll(".know-row")).toHaveLength(SCOPE_FIRST + 4);
  });

  it("filters by kind and by pinned, and says when nothing matches", () => {
    const facts = [fact({ key: "p1", kind: "preference" }), fact({ key: "f1", pinned: true }), fact({ key: "f2" })];
    render(<Claims facts={facts} tags={["budget"]} onChanged={() => undefined} />);
    const kind = screen.getByRole("group", { name: "Kind" });
    fireEvent.click(within(kind).getByRole("button", { name: /Preferences/ }));
    expect([...document.querySelectorAll(".know-key")].map((k) => k.getAttribute("title"))).toEqual(["p1"]);
    fireEvent.click(within(kind).getByRole("button", { name: /Pinned/ }));
    expect([...document.querySelectorAll(".know-key")].map((k) => k.getAttribute("title"))).toEqual(["f1"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search claims" }), { target: { value: "nothing like it" } });
    expect(screen.getByText("No claims match these words and filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(document.querySelectorAll(".know-row")).toHaveLength(3);
  });

  it("pins and edits from the row", async () => {
    const pin = vi.spyOn(api, "pinMemory").mockResolvedValue(fact({ pinned: true }));
    const changed = vi.fn();
    render(<Claims facts={[fact()]} tags={[]} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Monthly budget" }));
    expect(pin).toHaveBeenCalledWith("monthly_budget", true);
    await waitFor(() => expect(changed).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Edit Monthly budget" }));
    expect((screen.getByDisplayValue("1200 a month") as HTMLTextAreaElement).tagName).toBe("TEXTAREA");
  });

  it("is one Tab stop a row, its actions on the arrow keys", () => {
    render(<Claims facts={[fact()]} tags={[]} onChanged={() => undefined} />);
    const open = document.querySelector<HTMLButtonElement>(".know-open")!;
    const pin = screen.getByRole("button", { name: "Pin Monthly budget" });
    const edit = screen.getByRole("button", { name: "Edit Monthly budget" });
    const forget = screen.getByRole("button", { name: "Forget Monthly budget" });
    expect([pin, edit, forget].map((b) => b.tabIndex)).toEqual([-1, -1, -1]);
    open.focus();
    fireEvent.keyDown(open, { key: "ArrowRight" });
    expect(document.activeElement).toBe(pin);
    fireEvent.keyDown(pin, { key: "ArrowRight" });
    fireEvent.keyDown(edit, { key: "ArrowRight" });
    expect(document.activeElement).toBe(forget);
    fireEvent.keyDown(forget, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(edit);
  });

  it("pins, edits and asks to forget from one key on a focused row, and says so", async () => {
    const pin = vi.spyOn(api, "pinMemory").mockResolvedValue(fact({ pinned: true }));
    const forget = vi.spyOn(api, "deleteMemory").mockResolvedValue({ key: "monthly_budget", removed: true });
    const notice = vi.fn();
    render(<Claims facts={[fact()]} tags={[]} onChanged={() => undefined} onNotice={notice} />);
    const open = document.querySelector<HTMLButtonElement>(".know-open")!;
    open.focus();
    fireEvent.keyDown(open, { key: "p" });
    expect(pin).toHaveBeenCalledWith("monthly_budget", true);
    await waitFor(() => expect(notice).toHaveBeenCalledWith("Pinned monthly_budget"));
    // Delete only asks: the confirm opens and nothing is forgotten yet.
    fireEvent.keyDown(open, { key: "Delete" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(forget).not.toHaveBeenCalled();
    fireEvent.keyDown(open, { key: "e" });
    expect(screen.getByDisplayValue("1200 a month")).toBeTruthy();
  });

  it("leaves a letter typed on an action button alone", () => {
    const pin = vi.spyOn(api, "pinMemory").mockResolvedValue(fact({ pinned: true }));
    pin.mockClear();
    render(<Claims facts={[fact()]} tags={[]} onChanged={() => undefined} />);
    const edit = screen.getByRole("button", { name: "Edit Monthly budget" });
    fireEvent.keyDown(edit, { key: "p" });
    expect(pin).not.toHaveBeenCalled();
  });

  it("counts each kind on its chip", () => {
    render(<Claims facts={[fact({ key: "p1", kind: "preference" }), fact({ key: "f1", pinned: true }), fact({ key: "f2" })]} tags={[]} onChanged={() => undefined} />);
    const kind = screen.getByRole("group", { name: "Kind" });
    expect(within(kind).getAllByRole("button").map((b) => b.textContent)).toEqual(["All 3", "Preferences 1", "Facts 2", "Pinned 1"]);
  });

  it("forgets a claim from its row, after asking once", async () => {
    const forget = vi.spyOn(api, "deleteMemory").mockResolvedValue({ key: "monthly_budget", removed: true });
    const changed = vi.fn();
    render(<Claims facts={[fact()]} tags={[]} onChanged={changed} />);
    const button = screen.getByRole("button", { name: "Forget Monthly budget" });
    fireEvent.click(button);
    expect(forget).not.toHaveBeenCalled();
    // The row's actions stay drawn while it asks.
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Forget" }));
    expect(forget).toHaveBeenCalledWith("monthly_budget");
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it("narrows to one tag from the tag picker", () => {
    const facts = [fact({ key: "a", tags: ["budget"] }), fact({ key: "b", tags: ["travel"] }), fact({ key: "c", tags: [] })];
    render(<Claims facts={facts} tags={["travel", "budget"]} onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Tag" }));
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Any tag", "budget", "travel"]);
    fireEvent.click(within(list).getByRole("option", { name: "travel" }));
    expect([...document.querySelectorAll(".know-key")].map((k) => k.getAttribute("title"))).toEqual(["b"]);
    expect(document.getElementById(screen.getByRole("button", { name: "Tag" }).getAttribute("aria-describedby")!)?.textContent).toBe("travel");
  });

  it("says what memory is when it holds nothing", async () => {
    render(<Claims facts={[]} tags={[]} onChanged={() => undefined} />);
    expect(screen.getByText("Nothing remembered yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a claim" }));
    expect(screen.getByRole("textbox", { name: /^Name/ })).toBeTruthy();
    // The new claim is a sheet like every other: Cancel at its foot.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /^Name/ })).toBeNull());
    expect(screen.getByText("Nothing remembered yet.")).toBeTruthy();
  });

  it("draws where the claims will be while they are read, not that memory is empty", () => {
    render(<Claims facts={[]} tags={[]} loading onChanged={() => undefined} />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText("Nothing remembered yet.")).toBeNull();
  });

  it("says on the row who wrote a claim", () => {
    render(<Claims facts={[fact({ key: "a", source: "cron:10" }), fact({ key: "b", source: "dashboard" })]} tags={[]} onChanged={() => undefined} />);
    expect([...document.querySelectorAll(".know-from")].map((e) => e.textContent)).toEqual(["from a schedule", "from you"]);
  });
});

describe("a turn's memory, opened from its chat", () => {
  afterEach(() => {
    cleanup();
    window.location.hash = "";
  });

  it("shows only the claims the address names, until that is taken off", () => {
    window.location.hash = "#/memory?tab=claims&ids=1,3";
    const facts = [1, 2, 3].map((id) => fact({ id, key: `k${id}`, value: `value ${id}` }));
    render(<Claims facts={facts} tags={[]} onChanged={() => undefined} />);
    expect(screen.getByText("value 1")).toBeTruthy();
    expect(screen.queryByText("value 2")).toBeNull();
    expect(screen.getByText("value 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show every claim" }));
    expect(screen.getByText("value 2")).toBeTruthy();
    expect(window.location.hash).toBe("#/memory");
  });

  it("ignores ids that are not whole numbers it can hold", () => {
    window.location.hash = "#/memory?tab=claims&ids=,99999999999999999999,";
    render(<Claims facts={[fact({ id: 1, key: "k1", value: "value 1" })]} tags={[]} onChanged={() => undefined} />);
    expect(screen.getByText("value 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show every claim" })).toBeNull();
  });
});

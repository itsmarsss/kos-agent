// @vitest-environment jsdom
import type { PageSpec } from "@kos/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageRenderer } from "./PageRenderer.js";
import type { Row } from "./types.js";
import { widgetRenderer } from "./widgets.js";

/** Records every mutation the widgets ask for, and hands back fresh rows. */
function recorder(refreshed: Row[] = []) {
  const calls: Array<{
    pageId: string;
    widgetIndex: number;
    op: string;
    values?: Record<string, unknown>;
    key?: { column: string; value: unknown };
  }> = [];
  return {
    calls,
    onMutate: async (
      pageId: string,
      widgetIndex: number,
      op: string,
      values?: Record<string, unknown>,
      key?: { column: string; value: unknown },
    ): Promise<void> => {
      calls.push({ pageId, widgetIndex, op, values, key });
    },
    onRefresh: async (): Promise<Record<number, Row[]>> => ({ 0: refreshed }),
  };
}

function page(...widgets: PageSpec["widgets"]): PageSpec {
  return { id: "budget", title: "Budget Tracker", widgets };
}

describe("PageRenderer", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders widgets from a valid spec", () => {
    render(
      <PageRenderer
        spec={page(
          { type: "stat", label: "Spent", query: "SELECT 1" },
          { type: "table", query: "SELECT * FROM tx" },
        )}
        data={{ 0: [{ total: 42 }], 1: [{ a: 1, b: 2 }] }}
      />,
    );
    expect(screen.getByText("Budget Tracker")).toBeTruthy();
    expect(screen.getByText("Spent")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("flags an invalid spec instead of rendering it", () => {
    const bad = { id: "1 Bad", title: "x", widgets: [] } as unknown as PageSpec;
    render(<PageRenderer spec={bad} />);
    expect(screen.getByText(/Invalid page/)).toBeTruthy();
  });

  it("rejects an unknown widget type at the page level", () => {
    const spec = {
      id: "p",
      title: "P",
      widgets: [{ type: "spreadsheet", query: "SELECT 1" }],
    } as unknown as PageSpec;
    render(<PageRenderer spec={spec} />);
    expect(screen.getByText(/Invalid page/)).toBeTruthy();
  });

  it("falls back to the safe placeholder for an unknown widget type", () => {
    const Renderer = widgetRenderer("spreadsheet");
    render(
      <Renderer
        widget={{ type: "spreadsheet" } as unknown as PageSpec["widgets"][number]}
        rows={[]}
      />,
    );
    expect(screen.getByText(/unsupported widget: spreadsheet/)).toBeTruthy();
  });
});

describe("chart widget", () => {
  afterEach(cleanup);

  const rows = [
    { week: "w1", spent: 120, saved: 40 },
    { week: "w2", spent: 180, saved: 60 },
    { week: "w3", spent: 90, saved: 30 },
  ];

  for (const kind of ["line", "bar", "area", "pie"] as const) {
    it(`renders a real ${kind} chart, not the placeholder`, () => {
      const { container } = render(
        <PageRenderer
          spec={page({ type: "chart", kind, query: "SELECT 1", title: `${kind} spend` })}
          data={{ 0: rows }}
        />,
      );
      expect(screen.queryByText(/unsupported widget/)).toBeNull();
      const svg = container.querySelector("svg.kos-chart-svg");
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute("data-kind")).toBe(kind);
      // real marks, not a text stub
      expect(container.querySelectorAll("path, circle").length).toBeGreaterThan(0);
      // the table twin keeps every value reachable without hovering
      expect(screen.getByText("Data table")).toBeTruthy();
    });
  }

  it("gives each widget a layout cell, defaulting by type", () => {
    const { container } = render(
      <PageRenderer
        spec={{
          id: "p",
          title: "P",
          widgets: [
            { type: "stat", label: "Spent", query: "SELECT 1" },
            { type: "table", query: "SELECT 1" },
          ],
        }}
        data={{}}
      />,
    );
    // A stat is a tile; a table needs the row. Stacking both full width is
    // what turned a short page into several screens of scrolling.
    expect(container.querySelector(".kos-cell--quarter")).toBeTruthy();
    expect(container.querySelector(".kos-cell--full")).toBeTruthy();
  });

  it("lets the spec override the default width", () => {
    const { container } = render(
      <PageRenderer
        spec={{
          id: "p",
          title: "P",
          widgets: [{ type: "stat", label: "Spent", query: "SELECT 1", span: "half" }],
        }}
        data={{}}
      />,
    );
    expect(container.querySelector(".kos-cell--half")).toBeTruthy();
    expect(container.querySelector(".kos-cell--quarter")).toBeNull();
  });

  it("runs scripts in custom_html but keeps it cross-origin", () => {
    const { container } = render(
      <PageRenderer
        spec={{
          id: "p",
          title: "P",
          widgets: [{ type: "custom_html", html: "<canvas id=g></canvas>", height: 480 }],
        }}
        data={{}}
      />,
    );
    const frame = container.querySelector("iframe")!;
    // Scripts are the point of the escape hatch; same-origin is what would let
    // the frame rewrite its own sandbox and get out.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("<canvas id=g>");
    expect((frame as HTMLIFrameElement).style.height).toBe("480px");
  });

  it("repairs a closing tag the model escaped as if it were in a JS string", () => {
    const { container } = render(
      <PageRenderer
        spec={{
          id: "p",
          title: "P",
          widgets: [
            { type: "custom_html", html: "<script>var a=1;<\\/script><p>after</p>" },
          ],
        }}
        data={{}}
      />,
    );
    const srcdoc = container.querySelector("iframe")!.getAttribute("srcdoc")!;
    // Left as-is the script never closes and the whole frame does nothing.
    expect(srcdoc).toContain("</script>");
    expect(srcdoc).not.toContain("<\\/script>");
  });

  it("clamps an absurd custom_html height", () => {
    const { container } = render(
      <PageRenderer
        spec={{ id: "p", title: "P", widgets: [{ type: "custom_html", html: "x", height: 99999 }] }}
        data={{}}
      />,
    );
    expect((container.querySelector("iframe") as HTMLIFrameElement).style.height).toBe("900px");
  });

  it("shows a failed display query instead of an empty widget", () => {
    render(
      <PageRenderer
        spec={page({ type: "table", query: "SELECT * FROM missing" })}
        data={{}}
        errors={{ 0: "no such table: missing" }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("query failed");
    expect(screen.getByRole("alert").textContent).toContain("no such table");
  });

  it("draws one mark per category and names both series", () => {
    const { container } = render(
      <PageRenderer
        spec={page({ type: "chart", kind: "bar", query: "SELECT 1" })}
        data={{ 0: rows }}
      />,
    );
    // two series over three categories
    expect(container.querySelectorAll("svg path").length).toBe(6);
    // Scoped to the legend: the accessible data-table twin repeats both names.
    const legend = container.querySelector(".kos-chart-legend");
    expect(legend?.textContent).toContain("Spent");
    expect(legend?.textContent).toContain("Saved");
  });

  it("uses theme tokens for series color, never a hardcoded hex", () => {
    const { container } = render(
      <PageRenderer
        spec={page({ type: "chart", kind: "line", query: "SELECT 1" })}
        data={{ 0: rows }}
      />,
    );
    const line = container.querySelector("path.kos-chart-line");
    expect(line?.getAttribute("stroke")).toBe("var(--chart-1)");
  });

  it("survives a query that returned nothing", () => {
    render(
      <PageRenderer
        spec={page({ type: "chart", kind: "line", query: "SELECT 1" })}
        data={{ 0: [] }}
      />,
    );
    expect(screen.getByText("no chart data")).toBeTruthy();
    expect(screen.queryByText(/failed to render/)).toBeNull();
  });
});

describe("custom_html widget", () => {
  afterEach(cleanup);

  const html = '<p id="agent-markup">hello</p>';

  it("renders inside a sandbox that runs scripts but stays cross-origin", () => {
    const { container } = render(
      <PageRenderer spec={page({ type: "custom_html", html })} data={{}} />,
    );
    expect(screen.queryByText(/unsupported widget/)).toBeNull();
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    // An empty sandbox made the escape hatch unable to escape anything: no
    // interactive page can run without scripts. Withholding same-origin is
    // what keeps it away from the dashboard.
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("srcdoc")).toContain("agent-markup");
  });

  it("never injects the markup into the parent document", () => {
    const { container } = render(
      <PageRenderer
        spec={page({ type: "custom_html", html: '<p id="escaped">x</p>' })}
        data={{}}
      />,
    );
    expect(container.querySelector("#escaped")).toBeNull();
    expect(document.getElementById("escaped")).toBeNull();
  });
});

describe("form widget", () => {
  afterEach(cleanup);

  const spec = page({
    type: "form",
    title: "Add expense",
    mutate: { table: "tx", columns: ["label", "amount"] },
  });

  it("renders one labelled input per declared column", () => {
    render(<PageRenderer spec={spec} data={{}} />);
    expect(screen.queryByText(/unsupported widget/)).toBeNull();
    expect(screen.getByText("Label")).toBeTruthy();
    expect(screen.getByText("Amount")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("submits an insert through the guarded path and refreshes", async () => {
    const rec = recorder();
    const { container } = render(
      <PageRenderer spec={spec} data={{}} onMutate={rec.onMutate} onRefresh={rec.onRefresh} />,
    );
    const inputs = container.querySelectorAll("input.kos-input");
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: "coffee" } });
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: "4.5" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(rec.calls.length).toBe(1));
    expect(rec.calls[0]).toMatchObject({
      pageId: "budget",
      widgetIndex: 0,
      op: "insert",
      values: { label: "coffee", amount: "4.5" },
    });
    // the target table and columns come from the stored spec, never the client
    expect(rec.calls[0]?.values).not.toHaveProperty("table");
    expect(rec.calls[0]?.values).not.toHaveProperty("columns");
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("reports a failed write instead of crashing the widget", async () => {
    const { container } = render(
      <PageRenderer
        spec={spec}
        data={{}}
        onMutate={async () => {
          throw new Error("table is read-only");
        }}
        onRefresh={async () => ({})}
      />,
    );
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(await screen.findByText("table is read-only")).toBeTruthy();
    expect(screen.queryByText(/failed to render/)).toBeNull();
  });

  it("posts the wire contract to /api/mutate", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/mutate"
        ? new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json" },
          })
        : new Response(
            JSON.stringify({
              record: {},
              spec: { id: "budget", title: "t", widgets: [] },
              data: {},
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<PageRenderer spec={spec} data={{}} />);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mutate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      pageId: "budget",
      widgetIndex: 0,
      op: "insert",
      values: {},
    });
    // the refresh pulls the widget's rows back from the page endpoint
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/pages/budget");
  });
});

describe("list inline actions", () => {
  afterEach(cleanup);

  const spec = page({
    type: "list",
    query: "SELECT * FROM todo",
    mutate: { table: "todo", columns: ["task", "done"], allow: ["update", "delete"] },
  });
  const rows = [
    { id: 1, task: "buy milk", done: 0 },
    { id: 2, task: "call bank", done: 1 },
  ];

  it("renders the rows with a toggle and a delete button", () => {
    render(<PageRenderer spec={spec} data={{ 0: rows }} />);
    expect(screen.queryByText(/unsupported widget/)).toBeNull();
    expect(screen.getByText("buy milk")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBe(2);
  });

  it("toggles a row through the guarded path, keyed on its id", async () => {
    const rec = recorder(rows);
    render(
      <PageRenderer
        spec={spec}
        data={{ 0: rows }}
        onMutate={rec.onMutate}
        onRefresh={rec.onRefresh}
      />,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLInputElement);
    await waitFor(() => expect(rec.calls.length).toBe(1));
    expect(rec.calls[0]).toMatchObject({
      widgetIndex: 0,
      op: "update",
      values: { done: 1 },
      key: { column: "id", value: 1 },
    });
  });

  it("deletes a row and shows the refreshed rows", async () => {
    const rec = recorder([{ id: 2, task: "call bank", done: 1 }]);
    render(
      <PageRenderer
        spec={spec}
        data={{ 0: rows }}
        onMutate={rec.onMutate}
        onRefresh={rec.onRefresh}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0] as HTMLButtonElement);
    await waitFor(() => expect(rec.calls.length).toBe(1));
    expect(rec.calls[0]).toMatchObject({
      op: "delete",
      key: { column: "id", value: 1 },
    });
    await waitFor(() => expect(screen.queryByText("buy milk")).toBeNull());
  });
});

describe("card detail edit", () => {
  afterEach(cleanup);

  const spec = page({
    type: "card",
    query: "SELECT * FROM cars",
    mutate: { table: "cars", columns: ["name", "year"] },
  });
  const rows = [{ id: 7, name: "Skyline", year: 1999 }];

  it("opens a detail view when a card is tapped and saves an update", async () => {
    const rec = recorder(rows);
    render(
      <PageRenderer
        spec={spec}
        data={{ 0: rows }}
        onMutate={rec.onMutate}
        onRefresh={rec.onRefresh}
      />,
    );
    expect(screen.queryByText(/unsupported widget/)).toBeNull();
    fireEvent.click(screen.getByText("Skyline"));
    expect(screen.getByText("Edit record")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rec.calls.length).toBe(1));
    expect(rec.calls[0]).toMatchObject({
      op: "update",
      values: { name: "Skyline", year: "1999" },
      key: { column: "id", value: 7 },
    });
  });

  it("adds a record from the add button", async () => {
    const rec = recorder(rows);
    render(
      <PageRenderer
        spec={spec}
        data={{ 0: rows }}
        onMutate={rec.onMutate}
        onRefresh={rec.onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("New record")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rec.calls.length).toBe(1));
    expect(rec.calls[0]?.op).toBe("insert");
  });
});

describe("empty and formatted widgets", () => {
  afterEach(cleanup);

  it("says a table is empty rather than rendering nothing", () => {
    // Columns are read off the first row, so no rows meant no headers either:
    // a title over a blank box, which is what a new tracker always looks like.
    const { container } = render(
      <PageRenderer
        spec={{
          id: "p",
          title: "P",
          widgets: [{ type: "table", title: "Expenses", query: "SELECT 1" }],
        }}
        data={[[]]}
      />,
    );
    expect(container.textContent).toContain("nothing here yet");
  });

  it("renders a markdown widget as markdown, not as its own asterisks", () => {
    const { container } = render(
      <PageRenderer
        spec={{
          id: "p",
          title: "P",
          widgets: [{ type: "markdown", content: "**bold** and `code`" }],
        }}
        data={[[]]}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.textContent).not.toContain("**");
  });
});

describe("refresh after a write", () => {
  afterEach(cleanup);

  it("updates the widgets that read the table, not the form that wrote it", async () => {
    // The refresh was scoped to the writing widget. A form has no rows of its
    // own, so saving refreshed nothing: the table and the total sat unchanged
    // next to a green "Saved", which reads as a write that did not happen.
    const spec: PageSpec = {
      id: "budget",
      title: "Budget",
      widgets: [
        { type: "table", title: "Expenses", query: "SELECT 1" },
        {
          type: "form",
          title: "Log",
          mutate: { table: "budget_expenses", columns: ["amount"] },
        },
      ],
    };
    render(
      <PageRenderer
        spec={spec}
        data={{ 0: [] }}
        onMutate={async () => undefined}
        onRefresh={async () => ({ 0: [{ amount: 42.5 }], 1: [] })}
      />,
    );
    expect(screen.getByText("Expenses").parentElement?.textContent).toContain(
      "nothing here yet",
    );

    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: "42.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText("42.5")).toBeTruthy();
  });
});

describe("stat widget", () => {
  afterEach(cleanup);

  it("shows a placeholder when the aggregate is null", () => {
    // SUM over an empty table is null, which formatCell renders as "", so a
    // fresh tracker's headline number was an invisible blank.
    render(
      <PageRenderer
        spec={{
          id: "p",
          title: "P",
          widgets: [
            { type: "stat", label: "Total", query: "SELECT SUM(amount)" },
          ],
        }}
        data={{ 0: [{ total: null }] }}
      />,
    );
    expect(screen.getByText("Total").parentElement?.textContent).toContain("-");
  });
});

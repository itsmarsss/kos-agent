// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentEditor } from "./AgentEditor.js";
import { groupsOf, ToolPicker } from "./ToolPicker.js";

const TOOLS = [
  { name: "files.read", description: "" },
  { name: "files.ls", description: "" },
  { name: "search.grep", description: "" },
  { name: "browser.visit", description: "" },
  { name: "memory.recall", description: "" },
  { name: "mcp.gmail.send_email", description: "" },
];

let saved: (body: Record<string, unknown>) => Response;

beforeEach(() => {
  saved = () => new Response(JSON.stringify({ agent: { name: "x" } }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/tools") return new Response(JSON.stringify(TOOLS));
      if (path === "/api/agents") return new Response(JSON.stringify({ agents: [{ name: "recap" }], invalid: [] }));
      if (path === "/api/agents/save") return saved(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
};

describe("the new blob form", () => {
  it("says a taken or odd name under the field, and keeps Create off", async () => {
    render(<AgentEditor onSaved={() => undefined} onCancel={() => undefined} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/agents", expect.anything()));
    fill("What it is for", "Writes a recap");
    fireEvent.change(screen.getByPlaceholderText(/You watch one listing/), { target: { value: "You recap." } });
    fill("Name", "Recap");
    await screen.findByText("There is already a blob called “recap”. Pick another name.");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    fill("Name", "price watch");
    expect(screen.getByRole("alert").textContent).toMatch(/letters, digits and dashes/);
    fill("Name", "price-watch");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("puts the server's refusal of the name on the name, and submits on Enter", async () => {
    saved = () => new Response(JSON.stringify({ error: "There is already a blob called “ghost”. Pick another name.", field: "name", problem: "taken" }), { status: 409 });
    render(<AgentEditor onSaved={() => undefined} onCancel={() => undefined} />);
    fill("Name", "ghost");
    fill("What it is for", "Haunts");
    fireEvent.change(screen.getByPlaceholderText(/You watch one listing/), { target: { value: "You haunt." } });
    fireEvent.submit(screen.getByLabelText(/^Name/).closest("form")!);
    const said = await screen.findByRole("alert");
    expect(said.textContent).toBe("There is already a blob called “ghost”. Pick another name.");
    expect(said.closest("[data-field]")?.getAttribute("data-field")).toBe("Name");
  });

  it("keeps its looks folded away until asked", () => {
    render(<AgentEditor onSaved={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByText(/Eyes/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Change its looks/ }));
    expect(screen.queryAllByText(/Eyes/).length).toBeGreaterThan(0);
  });
});

describe("the tool picker", () => {
  it("groups families into plain groups, the rest as Everything else", () => {
    expect(groupsOf(["browser", "files", "memory", "mcp", "search"]).map((g) => [g.name, g.families])).toEqual([
      ["Files and folders", ["files", "search"]],
      ["The web", ["browser"]],
      ["Memory", ["memory"]],
      ["Everything else", ["mcp"]],
    ]);
  });

  it("switches a whole group off from the full toolkit, and shows the families only under Advanced", () => {
    const onChange = vi.fn();
    render(<ToolPicker tools={TOOLS} allow={null} onChange={onChange} />);
    expect(screen.queryByText("files")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Files and folders" }));
    expect(onChange).toHaveBeenCalledWith(["browser", "mcp", "memory"]);
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    expect(screen.getByText("files")).toBeTruthy();
    expect(screen.getByText("Read a file, List files")).toBeTruthy();
  });
});

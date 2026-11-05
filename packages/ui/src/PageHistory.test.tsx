// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type PageSummary } from "./api.js";
import { PageHistory } from "./PageHistory.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const record: PageSummary = { id: "budget", projectSlug: "budget", title: "Budget", path: "x", updatedAt: 1, kind: "html" };
const versions = [
  { version: 1, title: "Budget", kind: "html" as const, at: 1000 },
  { version: 2, title: "Budget", kind: "html" as const, at: 2000 },
];

/** A rollback that fails, or a history that will not load, says so instead of doing nothing. */
describe("a page's history", () => {
  it("says when its versions cannot be read", async () => {
    vi.spyOn(api, "pageHistory").mockRejectedValue(new Error("history unavailable"));
    render(<PageHistory record={record} onRolledBack={async () => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/history unavailable/);
  });

  it("says when a rollback fails, and when the page cannot be loaded after one", async () => {
    vi.spyOn(api, "pageHistory").mockResolvedValue(versions);
    const rollback = vi.spyOn(api, "pageRollback").mockRejectedValueOnce(new Error("no version 1"));
    const reload = vi.fn().mockRejectedValue(new Error("page not found"));
    render(<PageHistory record={record} onRolledBack={reload} />);
    const roll = async (): Promise<void> => {
      fireEvent.click(await screen.findByRole("button", { name: "Roll back" }));
      fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Roll back" })).getByRole("button", { name: "Roll back" }));
    };
    await roll();
    expect((await screen.findByRole("alert")).textContent).toMatch(/no version 1/);
    expect(reload).not.toHaveBeenCalled();
    rollback.mockResolvedValueOnce(record);
    await roll();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/page not found/));
  });
});

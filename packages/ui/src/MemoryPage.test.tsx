// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { MemoryPage } from "./MemoryPage.js";

/** The Memory page's tabs are tabs: one stop, the arrows between them, each naming its panel. */

beforeEach(() => {
  // jsdom has no ResizeObserver; the tab strip watches its width with one.
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  vi.spyOn(api, "memoryReview").mockResolvedValue({ pending: [], recent: [], pages: [], edited: [] });
  vi.spyOn(api, "memoryLog").mockResolvedValue({ events: [], query: "" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Memory page", () => {
  it("draws its sections as a tablist the arrow keys move along", async () => {
    render(<MemoryPage facts={[]} tags={[]} onChanged={() => undefined} />);
    await act(async () => {});
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Claims", "Decisions", "Pages", "Log", "Jobs", "Callers"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    await act(async () => {});
    expect(screen.getByRole("tab", { name: "Decisions" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Decisions" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    await act(async () => {});
    expect(screen.getByRole("tab", { name: "Callers" }).getAttribute("aria-selected")).toBe("true");
  });

  it("puts New claim in the page head, on the Claims tab only", async () => {
    render(<MemoryPage facts={[]} tags={[]} onChanged={() => undefined} />);
    await act(async () => {});
    const head = document.querySelector(".list-head")!;
    fireEvent.click(within(head as HTMLElement).getByRole("button", { name: "New claim" }));
    expect(screen.getByRole("textbox", { name: "Key" })).toBeTruthy();
    fireEvent.click(within(head as HTMLElement).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Key" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Log" }));
    await act(async () => {});
    expect(within(head as HTMLElement).queryByRole("button", { name: "New claim" })).toBeNull();
  });
});

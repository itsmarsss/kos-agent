// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageHead } from "./PageHead.js";
import { RunsTabs } from "./RunsTabs.js";

// jsdom has no ResizeObserver; the tab row watches its width with one.
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a page's head", () => {
  it("says what the page is, then its tools, then its tabs, in that order", () => {
    render(<PageHead title="Schedule" count={3} subtitle="Jobs KOS runs on its own." search={{ value: "", onChange: () => {}, noun: "schedules" }} actions={<button type="button">New schedule</button>} tabs={<RunsTabs current="crons" />} />);
    const head = screen.getByRole("banner");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Schedule3");
    const order = [...head.querySelectorAll("h1, p, input, button, nav")].map((e) => e.tagName);
    expect(order).toEqual(["H1", "P", "INPUT", "BUTTON", "NAV"]);
    expect(screen.getByPlaceholderText("Search schedules")).toBeTruthy();
  });

  it("draws Runs' tabs as links to their pages, the open one marked as the page", () => {
    render(<RunsTabs current="crons" />);
    const tabs = screen.getAllByRole("link");
    expect(tabs.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")])).toEqual([
      ["History", "#/history", null],
      ["Schedule", "#/schedule", "page"],
      ["Builds", "#/builds", null],
    ]);
    expect(screen.getByRole("navigation", { name: "Runs" }).className).toBe("page-tabs");
  });
});

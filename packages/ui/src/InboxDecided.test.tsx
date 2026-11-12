// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { DecidedAction } from "./api.js";
import { InboxDecided } from "./InboxDecided.js";

/**
 * What was decided sits under what still waits, short: a few rows, more in
 * pages, filtered by outcome and searched when there are many.
 */

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const STATUSES: DecidedAction["status"][] = ["approved", "approved", "denied", "expired"];

function rows(n: number): DecidedAction[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 - i,
    tool: "shell.run",
    args: "{}",
    reason: null,
    summary: `Action number ${i}`,
    conversationId: "c1",
    requestedAt: Date.now() - i * 60_000,
    status: STATUSES[i % STATUSES.length]!,
    decidedAt: Date.now() - i * 60_000,
    decidedBy: "owner",
    asker: "KOS",
  }));
}

const lines = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".inbox-decided-line")];

describe("the decided list", () => {
  it("shows the latest five, then pages of twenty", () => {
    render(<InboxDecided rows={rows(30)} onOpenChat={() => {}} />);
    expect(lines()).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Show all 30" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 20 more" }));
    expect(lines()).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(lines()).toHaveLength(30);
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(lines()).toHaveLength(5);
  });

  it("filters by outcome, with a count on each", () => {
    render(<InboxDecided rows={rows(8)} onOpenChat={() => {}} />);
    const group = screen.getByRole("group", { name: "Show decided" });
    fireEvent.click(within(group).getByRole("button", { name: /Denied/ }));
    expect(lines()).toHaveLength(2);
    expect(lines().every((l) => l.textContent?.includes("denied"))).toBe(true);
    expect(within(group).getByRole("button", { name: /Lapsed/ }).textContent).toContain("2");
  });

  it("searches only when there are many", () => {
    const { unmount } = render(<InboxDecided rows={rows(6)} onOpenChat={() => {}} />);
    expect(screen.queryByRole("searchbox")).toBeNull();
    unmount();
    render(<InboxDecided rows={rows(30)} onOpenChat={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search what was decided" }), { target: { value: "number 27" } });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.textContent).toContain("Action number 27");
  });

  it("opens a row to its details and the chat", () => {
    const open = vi.fn();
    render(<InboxDecided rows={rows(3)} onOpenChat={open} />);
    const first = lines()[0]!;
    expect(first.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("#1000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the chat" }));
    expect(open).toHaveBeenCalledWith("c1");
  });

  it("pages down to, and opens, the ask a link points at", () => {
    render(<InboxDecided rows={rows(30)} highlight={1000 - 22} onOpenChat={() => {}} />);
    expect(lines().length).toBeGreaterThanOrEqual(23);
    const row = document.querySelector(".inbox-decided-row.is-highlit")!;
    expect(row.textContent).toContain("Action number 22");
    expect(row.querySelector(".inbox-decided-line")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("draws nothing when nothing was decided", () => {
    const { container } = render(<InboxDecided rows={[]} onOpenChat={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

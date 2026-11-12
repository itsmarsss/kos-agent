// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type DecidedAction, type InboxData, type PendingAction } from "./api.js";
import { InboxPage } from "./InboxPage.js";

/**
 * The Inbox as a whole: what waits leads and is decided in place, what was
 * decided comes last, and the poll that redraws the page does not read the
 * history again unless something new was decided.
 */

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const decided: DecidedAction[] = Array.from({ length: 12 }, (_, i) => ({
  id: 500 - i,
  tool: "files.rm",
  reason: null,
  summary: `Delete old-${i}.txt`,
  conversationId: "c1",
  requestedAt: 1_000 + i,
  status: i % 3 === 0 ? "denied" : "approved",
  decidedAt: 2_000 - i,
  decidedBy: "owner",
}));

const ask: PendingAction = { id: 900, tool: "shell.run", args: "{}", reason: "a command that may write", summary: "Run: ls", conversationId: "c2", requestedAt: Date.now() - 60_000, asker: "KOS" };

function inbox(over: Partial<InboxData> = {}): InboxData {
  return { approvals: [ask], decisions: [], failures: [], suggestions: [], decided: { total: decided.length, latest: decided[0]!.id }, ...over };
}

let history: { mock: { calls: unknown[] } };
beforeEach(() => {
  history = vi.spyOn(api, "approvalHistory").mockImplementation(async ({ limit }) => decided.slice(0, limit));
  vi.spyOn(api, "approvalCounts").mockResolvedValue({ approved: 8, denied: 4, expired: 0 });
  vi.spyOn(api, "approval").mockImplementation(async (id: number) => decided.find((d) => d.id === id)!);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function page(data: InboxData | null, onDecide = vi.fn(), highlight?: number) {
  return (
    <InboxPage
      data={data}
      {...(highlight !== undefined ? { highlight } : {})}
      deciding={new Set()}
      onDecide={onDecide}
      onOpenChat={() => {}}
      onDismissFailure={() => {}}
      onOpenFailure={() => {}}
      onFixFailure={() => {}}
      onChanged={() => {}}
    />
  );
}

describe("the Inbox", () => {
  it("leads with what waits, decided in place, and puts what was decided last", async () => {
    const onDecide = vi.fn();
    render(page(inbox(), onDecide));
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Tool approvals/);
    expect(headings.at(-1)).toMatch(/^Decided/);
    const asks = screen.getByRole("heading", { name: /Tool approvals/ }).closest("section")!;
    fireEvent.click(within(asks).getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith(900, true);
    await waitFor(() => expect(document.querySelectorAll(".inbox-decided-line")).toHaveLength(5));
    expect(document.querySelector("#inbox-decided-title .count")!.textContent).toBe("12");
  });

  it("does not read the history again on a poll that changed nothing decided", async () => {
    const { rerender } = render(page(inbox()));
    await waitFor(() => expect(document.querySelectorAll(".inbox-decided-line")).toHaveLength(5));
    const before = history.mock.calls.length;
    // A poll: a fresh object with the same contents.
    rerender(page(inbox()));
    rerender(page(inbox({ approvals: [] })));
    await act(async () => {});
    expect(history.mock.calls.length).toBe(before);
    rerender(page(inbox({ approvals: [], decided: { total: 13, latest: 900 } })));
    await waitFor(() => expect(history.mock.calls.length).toBe(before + 1));
  });

  it("draws what was decided only once what waits has arrived, so a link's row stays where it was scrolled to", async () => {
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    scroll.mockClear();
    const { rerender } = render(page(null, vi.fn(), decided[2]!.id));
    await act(async () => {});
    expect(document.querySelector(".inbox-decided")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    rerender(page(inbox(), vi.fn(), decided[2]!.id));
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    expect(scroll.mock.contexts[0]).toBe(document.querySelector(".inbox-decided-row.is-highlit"));
  });

  it("says when nothing is waiting", async () => {
    render(page(inbox({ approvals: [], decided: { total: 0, latest: null } })));
    expect(screen.getByText("All clear.")).toBeTruthy();
    await act(async () => {});
  });
});

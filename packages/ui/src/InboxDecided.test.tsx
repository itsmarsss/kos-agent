// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api, type DecidedAction, type DecidedQuery } from "./api.js";
import { DECIDED_FIRST, DECIDED_PAGE, InboxDecided } from "./InboxDecided.js";

/**
 * What was decided sits under what still waits, short: a few rows, older
 * ones a page at a time from the server, filtered by outcome and searched
 * when there are many, and read again only when something new is decided.
 */

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom has no ResizeObserver; the filter strip watches its width with one.
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STATUSES: DecidedAction["status"][] = ["approved", "approved", "denied", "expired"];

function decidedRows(n: number): DecidedAction[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 - i,
    tool: "shell.run",
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

/** The server's decided history, over a list: pages after a row, by outcome, by words. */
function serve(all: DecidedAction[]) {
  const history = vi.spyOn(api, "approvalHistory").mockImplementation(async ({ limit, before, status, q }: DecidedQuery) => {
    const from = before ? all.findIndex((r) => r.id === before.id) + 1 : 0;
    return all
      .slice(from)
      .filter((r) => (!status || r.status === status) && (!q || r.summary.includes(q)))
      .slice(0, limit);
  });
  const counts = vi.spyOn(api, "approvalCounts").mockImplementation(async () => {
    const c = { approved: 0, denied: 0, expired: 0 };
    for (const r of all) c[r.status] += 1;
    return c;
  });
  const one = vi.spyOn(api, "approval").mockImplementation(async (id: number) => {
    const row = all.find((r) => r.id === id);
    if (!row) throw new Error("no such approval");
    return row;
  });
  return { history, counts, one };
}

const lines = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".inbox-decided-line")];
const mark = (n: number, latest = 1000): { total: number; latest: number } => ({ total: n, latest });
const headCount = (): string | null | undefined => document.querySelector("#inbox-decided-title .count")?.textContent;

describe("the decided list", () => {
  it("shows the latest five, then older ones a page at a time", async () => {
    const all = decidedRows(DECIDED_FIRST + DECIDED_PAGE + 3);
    const { history } = serve(all);
    render(<InboxDecided mark={mark(all.length)} onOpenChat={() => {}} />);
    await waitFor(() => expect(lines()).toHaveLength(DECIDED_FIRST));
    // One more than shown is asked for, so it knows there are older ones.
    expect(history).toHaveBeenLastCalledWith({ limit: DECIDED_FIRST + 1 });
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(lines()).toHaveLength(DECIDED_FIRST + DECIDED_PAGE));
    const last = all[DECIDED_FIRST - 1]!;
    expect(history).toHaveBeenLastCalledWith({ limit: DECIDED_PAGE + 1, before: { decidedAt: last.decidedAt, id: last.id } });
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(lines()).toHaveLength(all.length));
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(lines()).toHaveLength(DECIDED_FIRST);
  });

  it("loads one older page however fast it is pressed, and drops a page the filter has moved past", async () => {
    const all = decidedRows(DECIDED_FIRST + DECIDED_PAGE + 10);
    const { history } = serve(all);
    render(<InboxDecided mark={mark(all.length)} onOpenChat={() => {}} />);
    await waitFor(() => expect(lines()).toHaveLength(DECIDED_FIRST));
    const answer = history.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    history.mockImplementation(async (query: DecidedQuery) => {
      if (query.before) await gate;
      return answer(query);
    });
    const older = screen.getByRole("button", { name: "Load older" });
    fireEvent.click(older);
    fireEvent.click(older);
    fireEvent.click(screen.getByRole("button", { name: "Loading…" }));
    await act(async () => release());
    await waitFor(() => expect(lines()).toHaveLength(DECIDED_FIRST + DECIDED_PAGE));
    expect(history.mock.calls.filter(([q]) => (q as DecidedQuery).before)).toHaveLength(1);
    const shown = lines().map((l) => l.textContent);
    expect(new Set(shown).size).toBe(shown.length);

    // An older page still on its way when the filter changes is not appended to the new list.
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    history.mockImplementation(async (query: DecidedQuery) => {
      if (query.before) await gate2;
      return answer(query);
    });
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Show decided" })).getByRole("button", { name: /Denied/ }));
    await waitFor(() => expect(lines().every((l) => l.textContent?.includes("denied"))).toBe(true));
    await act(async () => release2());
    expect(lines().every((l) => l.textContent?.includes("denied"))).toBe(true);
    expect(lines()).toHaveLength(DECIDED_FIRST);
  });

  it("does not take a row without a decision time as a cursor", async () => {
    const all = decidedRows(DECIDED_FIRST + 3).map((r, i) => (i === DECIDED_FIRST - 1 ? { ...r, decidedAt: null } : r));
    const { history } = serve(all);
    render(<InboxDecided mark={mark(all.length)} onOpenChat={() => {}} />);
    await waitFor(() => expect(lines()).toHaveLength(DECIDED_FIRST));
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(history.mock.calls.some(([q]) => (q as DecidedQuery).before)).toBe(true));
    const cursor = history.mock.calls.map(([q]) => (q as DecidedQuery).before).find(Boolean)!;
    expect(cursor.id).toBe(all[DECIDED_FIRST - 2]!.id);
    // The row before it is the cursor, and the page that comes back does not repeat what is shown.
    await waitFor(() => expect(lines()).toHaveLength(all.length));
    expect(new Set(lines().map((l) => l.textContent)).size).toBe(all.length);
  });

  it("counts each outcome from the server, and filters by one", async () => {
    const { history } = serve(decidedRows(8));
    render(<InboxDecided mark={mark(8)} onOpenChat={() => {}} />);
    const group = await screen.findByRole("group", { name: "Show decided" });
    await waitFor(() => expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["All 8", "Approved 4", "Denied 2", "Lapsed 2"]));
    expect(headCount()).toBe("8");
    fireEvent.click(within(group).getByRole("button", { name: /Denied/ }));
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(history).toHaveBeenLastCalledWith({ limit: DECIDED_FIRST + 1, status: "denied" });
    expect(lines().every((l) => l.textContent?.includes("denied"))).toBe(true);
    expect(headCount()).toBe("2");
  });

  it("searches only when there are many, on the server, counting what it found", async () => {
    serve(decidedRows(6));
    const { unmount } = render(<InboxDecided mark={mark(6)} onOpenChat={() => {}} />);
    await waitFor(() => expect(lines()).toHaveLength(5));
    expect(screen.queryByRole("searchbox")).toBeNull();
    unmount();
    vi.restoreAllMocks();
    const { history } = serve(decidedRows(30));
    render(<InboxDecided mark={mark(30)} onOpenChat={() => {}} />);
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search what was decided" }), { target: { value: "number 2" } });
    // "number 2" and 20 to 29 are eleven: five shown, and the count says there are more.
    await waitFor(() => expect(history).toHaveBeenLastCalledWith({ limit: DECIDED_FIRST + 1, q: "number 2" }));
    await waitFor(() => expect(headCount()).toBe("5+"));
    expect(lines()[0]!.textContent).toContain("Action number 2");
  });

  it("offers a way back when nothing matches", async () => {
    serve(decidedRows(30));
    render(<InboxDecided mark={mark(30)} onOpenChat={() => {}} />);
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search what was decided" }), { target: { value: "nothing like it" } });
    await screen.findByText(/Nothing decided matches/);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(lines()).toHaveLength(DECIDED_FIRST));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  });

  it("reads the history again only when something new was decided", async () => {
    const { history, counts } = serve(decidedRows(8));
    const { rerender } = render(<InboxDecided mark={mark(8)} onOpenChat={() => {}} />);
    await waitFor(() => expect(lines()).toHaveLength(5));
    const [h, c] = [history.mock.calls.length, counts.mock.calls.length];
    // The Inbox polls; the same mark is the same history.
    rerender(<InboxDecided mark={mark(8)} onOpenChat={() => {}} />);
    await act(async () => {});
    expect(history.mock.calls.length).toBe(h);
    expect(counts.mock.calls.length).toBe(c);
    rerender(<InboxDecided mark={mark(9, 1001)} onOpenChat={() => {}} />);
    await waitFor(() => expect(history.mock.calls.length).toBe(h + 1));
    expect(counts.mock.calls.length).toBe(c + 1);
  });

  it("opens a row to its details and the chat", async () => {
    serve(decidedRows(3));
    const open = vi.fn();
    render(<InboxDecided mark={mark(3)} onOpenChat={open} />);
    await waitFor(() => expect(lines()).toHaveLength(3));
    const first = lines()[0]!;
    expect(first.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("#1000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the chat" }));
    expect(open).toHaveBeenCalledWith("c1");
  });

  it("reads an old ask a link points at on its own, and opens it", async () => {
    const all = decidedRows(40);
    const { one } = serve(all);
    render(<InboxDecided mark={mark(40)} highlight={all[30]!.id} onOpenChat={() => {}} />);
    await waitFor(() => expect(document.querySelector(".inbox-decided-row.is-highlit")).toBeTruthy());
    expect(one).toHaveBeenCalledWith(all[30]!.id);
    const row = document.querySelector(".inbox-decided-row.is-highlit")!;
    expect(row.textContent).toContain("Action number 30");
    expect(row.querySelector(".inbox-decided-line")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("clears the filters for a link once, and leaves the owner's own after that", async () => {
    const all = decidedRows(30);
    serve(all);
    const { rerender } = render(<InboxDecided mark={mark(30)} highlight={all[1]!.id} onOpenChat={() => {}} />);
    const group = await screen.findByRole("group", { name: "Show decided" });
    await waitFor(() => expect(lines().length).toBeGreaterThan(0));
    fireEvent.click(within(group).getByRole("button", { name: /Denied/ }));
    await waitFor(() => expect(lines().every((l) => l.textContent?.includes("denied"))).toBe(true));
    // The Inbox polls and something new is decided: the link is the same link.
    rerender(<InboxDecided mark={mark(31, 1001)} highlight={all[1]!.id} onOpenChat={() => {}} />);
    await act(async () => {});
    expect(within(group).getByRole("button", { name: /Denied/ }).getAttribute("aria-pressed")).toBe("true");
    // A link to another ask clears them again.
    rerender(<InboxDecided mark={mark(31, 1001)} highlight={all[2]!.id} onOpenChat={() => {}} />);
    await waitFor(() => expect(within(group).getByRole("button", { name: /All/ }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("scrolls to a linked ask once its row arrives, and only once", async () => {
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    scroll.mockClear();
    const all = decidedRows(8);
    // The history comes back after the page has drawn, as it does over the network.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    serve(all);
    const history = vi.mocked(api.approvalHistory);
    const answer = history.getMockImplementation()!;
    history.mockImplementation(async (query) => {
      await gate;
      return answer(query);
    });
    vi.mocked(api.approval).mockImplementation(async () => {
      await gate;
      return all[2]!;
    });
    const { rerender } = render(<InboxDecided mark={mark(8)} highlight={all[2]!.id} onOpenChat={() => {}} />);
    await act(async () => {});
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    expect(scroll.mock.contexts[0]).toBe(document.querySelector(".inbox-decided-row.is-highlit"));
    rerender(<InboxDecided mark={mark(9, 1001)} highlight={all[2]!.id} onOpenChat={() => {}} />);
    await act(async () => {});
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("marks an older linked ask as the linked one, and says when there is no such ask", async () => {
    const all = decidedRows(40);
    serve(all);
    const { unmount } = render(<InboxDecided mark={mark(40)} highlight={all[30]!.id} onOpenChat={() => {}} />);
    await waitFor(() => expect(document.querySelector(".inbox-decided-row.is-highlit")).toBeTruthy());
    expect(document.querySelector(".inbox-decided-row.is-highlit .tag")?.textContent).toBe("Linked");
    // One of the newest five is already in the list: no tag.
    unmount();
    render(<InboxDecided mark={mark(40)} highlight={all[1]!.id} onOpenChat={() => {}} />);
    await waitFor(() => expect(document.querySelector(".inbox-decided-row.is-highlit")).toBeTruthy());
    expect(document.querySelector(".inbox-decided-row.is-highlit .tag")).toBeNull();
    cleanup();
    render(<InboxDecided mark={mark(40)} highlight={77} onOpenChat={() => {}} />);
    expect(await screen.findByText("No ask #77.")).toBeTruthy();
  });

  it("says a row's words again opened only when its line cut them", async () => {
    const all = decidedRows(2);
    serve(all);
    // The first row's words run past its line; the second's fit.
    const width = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.id === String(all[0]!.id) ? 900 : 0;
    });
    render(<InboxDecided mark={mark(2)} onOpenChat={() => {}} />);
    await waitFor(() => expect(lines()).toHaveLength(2));
    fireEvent.click(lines()[0]!);
    fireEvent.click(lines()[1]!);
    const full = [...document.querySelectorAll(".inbox-decided-full")].map((e) => e.textContent);
    expect(full).toEqual([all[0]!.summary]);
    width.mockRestore();
  });

  it("draws nothing when nothing was decided", async () => {
    serve([]);
    const { container } = render(<InboxDecided mark={{ total: 0, latest: null }} onOpenChat={() => {}} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });
});

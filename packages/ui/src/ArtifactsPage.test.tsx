// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api, type AgentInfo, type ArtifactSummary, type Project } from "./api.js";
import { ArtifactViewer, ArtifactsPage, chatOf, convertRequest, editRequest, settleOpenViewers } from "./ArtifactsPage.js";
import { HANDOFF_MS, newRequest } from "./NewArtifact.js";
import { hrefFor, NAV, parseRoute } from "./routes.js";

beforeAll(() => {
  window.matchMedia ??= (() => ({ addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const projects = [{ slug: "budget", name: "Household budget" }] as Project[];
const at = (n: number): number => Date.now() - n * 60_000;
const ART: ArtifactSummary[] = [
  { id: "spend", projectSlug: "budget", title: "Spending board", description: "Where the money went this month.", path: "", updatedAt: at(5), kind: "html", artifactKind: "page", capturedAt: at(1) },
  { id: "brief", projectSlug: null, title: "Q4 brief", description: "What we decided and why.", path: "", updatedAt: at(10), kind: "html", artifactKind: "doc", capturedAt: at(20) },
  { id: "pitch", projectSlug: null, title: "Garden pitch", path: "", updatedAt: at(30), kind: "html", artifactKind: "deck" },
  { id: "ledger", projectSlug: "budget", title: "Ledger", description: "Every expense, with totals by category.", path: "", updatedAt: at(40), kind: "html", artifactKind: "sheet", capturedAt: at(39) },
];

/** The cards' titles, in order; each card's menu beside it is no card. */
const titles = (): string[] =>
  within(screen.getByRole("list", { name: "Artifacts" }))
    .getAllByRole("button")
    .filter((b) => b.classList.contains("artifact-card"))
    .map((b) => b.querySelector(".artifact-card-title")?.textContent ?? "");

describe("the Artifacts page", () => {
  it("is in the nav and has a route for the gallery and for one artifact", () => {
    expect(NAV.map((n) => n.label)).toContain("Artifacts");
    expect(parseRoute("#/artifacts")).toEqual({ name: "artifacts" });
    expect(parseRoute("#/artifacts/q4-brief")).toEqual({ name: "artifacts", id: "q4-brief" });
    expect(hrefFor({ name: "artifacts", id: "a b" })).toBe("#/artifacts/a%20b");
  });

  it("shows every artifact newest first with its kind, owner and time, filtered by kind, project and words", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue(ART);
    vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    await waitFor(() => expect(titles()).toEqual(["Spending board", "Q4 brief", "Garden pitch", "Ledger"]));
    const card = screen.getByText("Spending board").closest("button")!;
    expect(within(card).getByText("Page")).toBeTruthy();
    expect(within(card).getByText("Household budget")).toBeTruthy();
    expect(within(screen.getByText("Q4 brief").closest("button")!).getByText("Workspace")).toBeTruthy();

    // Each kind says how many it holds.
    expect(screen.getByRole("button", { name: "All4" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Decks1" }));
    expect(titles()).toEqual(["Garden pitch"]);
    fireEvent.click(screen.getByRole("button", { name: "All4" }));
    fireEvent.change(screen.getByLabelText("Search artifacts"), { target: { value: "totals by category" } });
    expect(titles()).toEqual(["Ledger"]);
    fireEvent.change(screen.getByLabelText("Search artifacts"), { target: { value: "nothing like this" } });
    expect(screen.getByText("No artifact matches these filters.")).toBeTruthy();
    // A kind with none left is left out, All kept.
    expect(screen.queryByRole("button", { name: /^Decks/ })).toBeNull();
    expect(screen.getByRole("button", { name: "All0" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titles()).toHaveLength(4);
    // The one chosen stays, at nought, so it can be let go.
    fireEvent.click(screen.getByRole("button", { name: "Decks1" }));
    fireEvent.change(screen.getByLabelText("Search artifacts"), { target: { value: "ledger" } });
    expect(screen.getByRole("button", { name: "Decks0" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("draws cards in their shape while it loads, then groups them by project on asking", async () => {
    let answer: (list: ArtifactSummary[]) => void = () => undefined;
    vi.spyOn(api, "artifacts").mockReturnValue(new Promise((r) => (answer = r)));
    vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    const { container } = render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    expect(screen.getByRole("list", { name: "Loading artifacts" }).getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    answer(ART);
    await waitFor(() => expect(titles()).toHaveLength(4));
    expect(screen.queryByRole("list", { name: "Loading artifacts" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    fireEvent.click(screen.getByRole("option", { name: "By owner" }));
    const inGroup = (name: string): string[] => [...screen.getByRole("list", { name }).querySelectorAll(".artifact-card-title")].map((t) => t.textContent ?? "");
    expect(inGroup("Household budget")).toEqual(["Spending board", "Ledger"]);
    // The workspace's own come last.
    expect(inGroup("Workspace")).toEqual(["Q4 brief", "Garden pitch"]);
    const heads = [...container.querySelectorAll(".artifact-group > .label")].map((h) => h.textContent);
    expect(heads).toEqual(["Household budget2", "Workspace2"]);
  });

  it("makes a new artifact from a kind, an owner and a sentence, asked in the owner's own chat", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([]);
    vi.spyOn(api, "agents").mockResolvedValue({ agents: [{ name: "noter" } as AgentInfo], invalid: [] });
    const sent = vi.spyOn(api, "message").mockResolvedValue({} as never);
    const asked = vi.fn();
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} onAsked={asked} />);
    await screen.findByText("Nothing made yet");
    // In the head, and beside the empty gallery.
    const buttons = screen.getAllByRole("button", { name: "New artifact" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New artifact" });
    // A doc to begin with; the arrows walk the kinds as a radio group.
    const kinds = within(dialog).getByRole("radiogroup", { name: "Kind" });
    expect(within(kinds).getByRole("radio", { name: /Doc/ }).getAttribute("aria-checked")).toBe("true");
    // Each named by its kind alone, what it is for read as its description.
    const deck = within(kinds).getByRole("radio", { name: "Deck" });
    expect(document.getElementById(deck.getAttribute("aria-describedby")!)?.textContent).toBe("Slides to present, 16:9");
    fireEvent.keyDown(kinds, { key: "End" });
    expect(within(kinds).getByRole("radio", { name: "Page" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(kinds, { key: "Home" });
    fireEvent.keyDown(kinds, { key: "ArrowRight" });
    expect(deck.getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByText("Goes to KOS")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Owner" }));
    fireEvent.click(await screen.findByRole("option", { name: "Household budget" }));
    expect(within(dialog).getByText("Goes to Household budget's chat")).toBeTruthy();
    const ask = within(dialog).getByRole("button", { name: "Ask KOS" }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("What should it be?"), { target: { value: "Ten slides on the quarter" } });
    fireEvent.click(ask);
    expect(sent).toHaveBeenCalledWith(newRequest("deck", "Ten slides on the quarter", { project: "budget" }), "project:budget");
    await waitFor(() => expect(asked).toHaveBeenCalledWith({ project: "budget" }, expect.any(Promise)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the dialog and the words when the request cannot be sent, and says why", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([]);
    vi.spyOn(api, "agents").mockResolvedValue({ agents: [], invalid: [] });
    let refuse: (err: Error) => void = () => undefined;
    vi.spyOn(api, "message").mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    const asked = vi.fn();
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} onAsked={asked} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "New artifact" }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New artifact" });
    fireEvent.change(within(dialog).getByLabelText("What should it be?"), { target: { value: "A memo on the move" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ask KOS" }));
    // Said while it is on its way, and not sent twice.
    const busy = within(dialog).getByRole("button", { name: "Asking…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    refuse(new Error("KOS is halted"));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Could not ask KOS: KOS is halted");
    expect((within(dialog).getByLabelText("What should it be?") as HTMLTextAreaElement).value).toBe("A memo on the move");
    expect(within(dialog).getByRole("button", { name: "Ask KOS" })).toBeTruthy();
    expect(asked).not.toHaveBeenCalled();
  });

  it("hands over to the chat once the send has been on its way a moment, the answer still to come, and hands on a late failure", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([]);
    vi.spyOn(api, "agents").mockResolvedValue({ agents: [], invalid: [] });
    let refuse: (err: Error) => void = () => undefined;
    vi.spyOn(api, "message").mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    const asked = vi.fn();
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} onAsked={asked} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "New artifact" }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New artifact" });
    fireEvent.change(within(dialog).getByLabelText("What should it be?"), { target: { value: "A memo" } });
    vi.useFakeTimers();
    try {
      fireEvent.click(within(dialog).getByRole("button", { name: "Ask KOS" }));
      await act(() => vi.advanceTimersByTimeAsync(HANDOFF_MS - 100));
      expect(asked).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(asked).toHaveBeenCalledWith(null, expect.any(Promise));
      // The dialog has gone: the send failing now is the dashboard's to say, through what it was handed.
      const late = (asked.mock.calls[0] as [unknown, Promise<unknown>])[1];
      refuse(new Error("KOS is halted"));
      await expect(late).rejects.toThrow("KOS is halted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves nobody when the page went before the send handed over", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([]);
    vi.spyOn(api, "agents").mockResolvedValue({ agents: [], invalid: [] });
    vi.spyOn(api, "message").mockReturnValue(new Promise(() => undefined));
    const asked = vi.fn();
    const { unmount } = render(<ArtifactsPage projects={projects} onOpen={() => undefined} onAsked={asked} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "New artifact" }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "New artifact" });
    fireEvent.change(within(dialog).getByLabelText("What should it be?"), { target: { value: "A memo" } });
    vi.useFakeTimers();
    try {
      fireEvent.click(within(dialog).getByRole("button", { name: "Ask KOS" }));
      unmount();
      await vi.advanceTimersByTimeAsync(HANDOFF_MS + 100);
      expect(asked).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back to the workspace when the owner chosen is no longer offered", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([]);
    const agents = vi.spyOn(api, "agents").mockResolvedValue({ agents: [{ name: "noter" } as AgentInfo], invalid: [] });
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} onAsked={() => undefined} />);
    const open = async (): Promise<HTMLElement> => {
      fireEvent.click((await screen.findAllByRole("button", { name: "New artifact" }))[0]!);
      return screen.findByRole("dialog", { name: "New artifact" });
    };
    let dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Owner" }));
    fireEvent.click(await screen.findByRole("option", { name: "noter" }));
    expect(within(dialog).getByText("Goes to noter's chat")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The blob is removed before the dialog opens again.
    agents.mockResolvedValue({ agents: [], invalid: [] });
    dialog = await open();
    await waitFor(() => expect(within(dialog).getByText("Goes to KOS")).toBeTruthy());
  });

  it("asks KOS at the root for a workspace artifact, and a blob in its own thread", () => {
    expect(newRequest("doc", " A memo ", null)).toBe(
      "A memo\n\nWrite it as a doc: read artifacts.guide for a doc, write it with artifacts.write, leaving project out so it is a workspace artifact, and check it once with artifacts.check.",
    );
    expect(newRequest("sheet", "Budget", { blob: "noter" })).toContain("write it with artifacts.write, leaving project out so it is your own,");
    expect(newRequest("page", "Board", { project: "garden" })).toContain("write it with artifacts.write for @project:garden, and check it once");
  });

  it("shows a capture when there is a fresh one and redraws a missing or stale one, one at a time", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue(ART);
    const check = vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    const { container } = render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    // The doc's capture is older than the doc, and the deck has none.
    expect(check.mock.calls.map((c) => c[0])).toEqual(["brief", "pitch"]);
    await waitFor(() => expect(container.querySelectorAll(".artifact-thumb img")).toHaveLength(4));
    expect(container.querySelector(".artifact-thumb img")?.getAttribute("src")).toMatch(/^\/api\/artifacts\/spend\/thumb\?theme=dark&v=\d+$/);
  });

  it("redraws no more than eight captures in a visit, however many are stale", async () => {
    const stale = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, projectSlug: null, title: `A${i}`, path: "", updatedAt: at(i), kind: "html", artifactKind: "doc" }) as ArtifactSummary);
    vi.spyOn(api, "artifacts").mockResolvedValue(stale);
    const check = vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    const { container } = render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    await waitFor(() => expect(container.querySelectorAll(".artifact-thumb img")).toHaveLength(8));
    await new Promise((r) => setTimeout(r, 50));
    expect(check).toHaveBeenCalledTimes(8);
    expect(check.mock.calls.map((c) => c[0])).toEqual(stale.slice(0, 8).map((a) => a.id));
  });

  it("lists an older widget page, marked as one, and never redraws it", async () => {
    const widget = { id: "old", projectSlug: "budget", title: "Old board", path: "", updatedAt: at(1), kind: "spec", artifactKind: "page" } as ArtifactSummary;
    vi.spyOn(api, "artifacts").mockResolvedValue([widget, ...ART]);
    const check = vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    await waitFor(() => expect(titles()).toContain("Old board"));
    expect(within(screen.getByText("Old board").closest("button")!).getByTitle(/older widget page/i).textContent).toBe("Widgets");
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(check.mock.calls.map((c) => c[0])).not.toContain("old");
  });

  it("tells the workspace from a project whose slug is workspace", async () => {
    const mine = { id: "plan", projectSlug: "workspace", title: "Office plan", path: "", updatedAt: at(2), kind: "html", artifactKind: "page", capturedAt: at(1) } as ArtifactSummary;
    vi.spyOn(api, "artifacts").mockResolvedValue([mine, ...ART]);
    vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    render(<ArtifactsPage projects={[...projects, { slug: "workspace", name: "Office" } as Project]} onOpen={() => undefined} />);
    await waitFor(() => expect(titles()).toHaveLength(5));
    const choose = (label: string): void => {
      fireEvent.click(screen.getByRole("button", { name: "Owner" }));
      fireEvent.click(screen.getByRole("option", { name: label }));
    };
    choose("Office");
    expect(titles()).toEqual(["Office plan"]);
    choose("Workspace");
    expect(titles()).toEqual(["Q4 brief", "Garden pitch"]);
  });

  it("names a blob as the owner of what it made, and filters by it", async () => {
    const notes = { id: "notes", projectSlug: null, blob: "noter", title: "Noter's notes", path: "", updatedAt: at(1), kind: "html", artifactKind: "doc", capturedAt: at(0) } as ArtifactSummary;
    vi.spyOn(api, "artifacts").mockResolvedValue([notes, ...ART]);
    vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    await waitFor(() => expect(titles()).toHaveLength(5));
    expect(within(screen.getByText("Noter's notes").closest("button")!).getByText("noter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Owner" }));
    fireEvent.click(screen.getByRole("option", { name: "noter" }));
    expect(titles()).toEqual(["Noter's notes"]);
    // The workspace's own are not a blob's.
    fireEvent.click(screen.getByRole("button", { name: "Owner" }));
    fireEvent.click(screen.getByRole("option", { name: "Workspace" }));
    expect(titles()).toEqual(["Q4 brief", "Garden pitch"]);
  });

  it("opens an artifact from its card, and says plainly when there are none", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue(ART.slice(0, 1));
    const open = vi.fn();
    render(<ArtifactsPage projects={projects} onOpen={open} />);
    fireEvent.click(await screen.findByText("Spending board"));
    expect(open).toHaveBeenCalledWith("spend");
    cleanup();
    vi.spyOn(api, "artifacts").mockResolvedValue([]);
    render(<ArtifactsPage projects={projects} onOpen={open} />);
    expect(await screen.findByText("Nothing made yet")).toBeTruthy();
  });
});

describe("one artifact, full size", () => {
  const deck = { record: ART[2]!, kind: "html" as const, page: { id: "pitch", title: "Garden pitch", kind: "deck" as const, html: "<main data-deck><section><h1>Pitch</h1></section></main>" } };

  it("offers presenting for a deck, and asks the owning chat for a change in the owner's words", async () => {
    vi.spyOn(api, "anyPage").mockResolvedValue(deck as never);
    vi.spyOn(api, "pageHistory").mockResolvedValue([]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const sent = vi.spyOn(api, "message").mockResolvedValue({ reply: "" } as never);
    const opened = vi.fn();
    render(<ArtifactViewer id="pitch" projects={projects} onBack={() => undefined} onOpenChat={opened} />);
    expect(await screen.findByRole("button", { name: "Present" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit with KOS" }));
    fireEvent.change(screen.getByLabelText(/What should change/), { target: { value: "Add a slide on cost" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask KOS" }));
    expect(sent).toHaveBeenCalledWith(editRequest("Add a slide on cost", ART[2]!), undefined);
    expect(sent.mock.calls[0]?.[0]).toMatch(/^Add a slide on cost\n\nThis is about @page:pitch, the deck "Garden pitch"/);
    expect(opened).toHaveBeenCalledWith(null);
    // The request went to KOS at the root, so that is the chat opened, not the chat list: the owner's Main, by the owner id this KOS has.
    vi.spyOn(api, "settings").mockResolvedValue({ profile: { name: "K", timezone: "UTC", ownerId: "kenny" } } as never);
    expect(await chatOf(null)).toEqual({ name: "chats", id: "primary:kenny" });
    expect(hrefFor(await chatOf(null))).toBe(hrefFor({ name: "chats", id: "primary:kenny" }));
    expect(await chatOf({ project: "budget" })).toEqual({ name: "project", slug: "budget" });
    expect(await chatOf({ blob: "noter" })).toEqual({ name: "blobs", blob: "noter" });
  });

  it("opens the chat list when KOS's root chat cannot be named, and names it once the settings load", async () => {
    // A fresh module: the root chat's id is kept once known.
    vi.resetModules();
    const fresh = await import("./api.js");
    const { chatOf: freshChatOf } = await import("./ArtifactsPage.js");
    vi.spyOn(fresh.api, "settings").mockRejectedValue(new Error("offline"));
    expect(await freshChatOf(null)).toEqual({ name: "chats" });
    vi.spyOn(fresh.api, "settings").mockResolvedValue({ profile: { name: "K", timezone: "UTC", ownerId: "kenny" } } as never);
    expect(await freshChatOf(null)).toEqual({ name: "chats", id: "primary:kenny" });
  });

  it("shows a removed blob's artifact as kept: named so, no way to its missing page or to KOS, and the owner's to put in the trash", async () => {
    const record = { id: "notes", projectSlug: null, blob: "noter", blobId: "old", blobRemoved: true as const, title: "Notes", path: "", updatedAt: at(1), kind: "html" as const, artifactKind: "doc" as const };
    vi.spyOn(api, "anyPage").mockResolvedValue({ record, kind: "html", page: { id: "notes", title: "Notes", kind: "doc", html: "<article data-doc></article>" } } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const trashed = vi.spyOn(api, "trashArtifact").mockResolvedValue({ ...record, trashedAt: Date.now() });
    render(<ArtifactViewer id="notes" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} onOpenOwner={() => undefined} />);
    expect(await screen.findByText("Removed blob: noter")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit with KOS" })).toBeNull();
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    // Nothing new goes to a removed blob: its work is moved out, never copied in place.
    expect(screen.queryByRole("menuitem", { name: "Duplicate" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Move to…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to trash" }));
    await waitFor(() => expect(trashed).toHaveBeenCalledWith("notes"));
    expect(await screen.findByText(/This artifact is in the trash/)).toBeTruthy();
  });

  it("lists a removed blob's artifacts apart from a later blob of its name", async () => {
    const old = { id: "old-notes", projectSlug: null, blob: "noter", blobId: "old", blobRemoved: true, title: "Old notes", path: "", updatedAt: at(3), kind: "html", artifactKind: "doc", capturedAt: at(0) } as ArtifactSummary;
    const now = { id: "new-notes", projectSlug: null, blob: "noter", blobId: "new", title: "New notes", path: "", updatedAt: at(2), kind: "html", artifactKind: "doc", capturedAt: at(0) } as ArtifactSummary;
    vi.spyOn(api, "artifacts").mockResolvedValue([old, now, ...ART]);
    vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    await waitFor(() => expect(titles()).toHaveLength(6));
    expect(within(screen.getByText("Old notes").closest("button")!).getByText("Removed blob: noter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Owner" }));
    fireEvent.click(screen.getByRole("option", { name: "Removed blob: noter" }));
    expect(titles()).toEqual(["Old notes"]);
    fireEvent.click(screen.getByRole("button", { name: "Owner" }));
    fireEvent.click(screen.getByRole("option", { name: "noter" }));
    expect(titles()).toEqual(["New notes"]);
  });

  it("draws a deck's controls in its one head row: the slide, notes, grid and one Present", async () => {
    const record = ART[2]!;
    vi.spyOn(api, "anyPage").mockResolvedValue({ record, kind: "html", page: { id: "pitch", title: "Garden pitch", kind: "deck", html: "<main data-deck><section>a</section></main>" } } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    render(<ArtifactViewer id="pitch" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const el = await waitFor(() => {
      const f = document.querySelector<HTMLIFrameElement>("iframe.artifact-frame");
      if (!f) throw new Error("no frame yet");
      return f;
    });
    const pageWin = document.body.appendChild(document.createElement("iframe")).contentWindow!;
    Object.defineProperty(el.contentWindow!, "frames", { value: [pageWin], configurable: true });
    const told = vi.spyOn(pageWin, "postMessage");
    act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data: { __kos: "deck", index: 0, count: 4, grid: false, notes: false, reading: false, hosted: true } })));
    const head = screen.getByRole("banner");
    expect(within(head).getByRole("heading", { level: 1 }).textContent).toBe("Garden pitch");
    expect(within(head).getByText("1 / 4")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Present" })).toHaveLength(1);
    expect((within(head).getByRole("button", { name: "Previous slide" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(head).getByRole("button", { name: "Next slide" }));
    expect(told).toHaveBeenLastCalledWith({ __kos: "deck-do", action: "next" }, "*");
    fireEvent.click(within(head).getByRole("button", { name: "Notes" }));
    expect(told).toHaveBeenLastCalledWith({ __kos: "deck-do", action: "notes" }, "*");
  });

  it("presents a deck with its notes from the menu: the presenter view here, the slide in an audience window", async () => {
    const record = ART[2]!;
    vi.spyOn(api, "anyPage").mockResolvedValue({ record, kind: "html", page: { id: "pitch", title: "Garden pitch", kind: "deck", html: "<main data-deck><section>a</section></main>" } } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const audience = { closed: false, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(audience as unknown as Window);
    render(<ArtifactViewer id="pitch" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const el = await waitFor(() => {
      const f = document.querySelector<HTMLIFrameElement>("iframe.artifact-frame");
      if (!f) throw new Error("no frame yet");
      return f;
    });
    const menuItems = (): string[] => {
      fireEvent.click(screen.getByRole("button", { name: "More" }));
      const names = within(screen.getByRole("menu", { name: "More" })).queryAllByRole("menuitem").map((i) => i.textContent ?? "");
      fireEvent.keyDown(screen.getByRole("menu", { name: "More" }), { key: "Escape" });
      return names;
    };
    // Not until the deck has said where it is, and never on a phone held upright, where its slides stack.
    expect(menuItems()).not.toContain("Present with notes");
    const pageWin = document.body.appendChild(document.createElement("iframe")).contentWindow!;
    Object.defineProperty(el.contentWindow!, "frames", { value: [pageWin], configurable: true });
    const told = vi.spyOn(pageWin, "postMessage");
    const report = (data: Record<string, unknown>): void => act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data: { __kos: "deck", count: 4, grid: false, notes: false, hosted: true, ...data } })));
    report({ index: 2, reading: true });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(menuItems()).not.toContain("Present with notes");
    report({ index: 2, reading: false });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Present with notes" }));
    // The audience window is the dashboard's own page, opened in the owner's press; the deck is read again, so the presenter starts from the newest version.
    expect(open).toHaveBeenCalledTimes(1);
    expect(api.anyPage).toHaveBeenCalledTimes(2);
    // The same version read again keeps the viewer's frame: its deck does not start over.
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    expect(el.isConnected).toBe(true);
    expect(document.querySelector("iframe.artifact-frame")).toBe(el);
    expect(String(open.mock.calls[0]![0])).toMatch(/#\/audience\/pitch\/[0-9a-f]{24}$/);
    const view = screen.getByRole("dialog", { name: "Presenting Garden pitch" });
    expect(within(view).getByText("Slide 3 of 4")).toBeTruthy();
    expect(within(view).getByText("Opening the audience window")).toBeTruthy();
    fireEvent.keyDown(view, { key: "ArrowRight" });
    expect(within(view).getByText("Slide 4 of 4")).toBeTruthy();
    // Escape ends it: the audience window closes, and the viewer's deck is where the presenter left it.
    fireEvent.keyDown(view, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(audience.close).toHaveBeenCalled();
    expect(told).toHaveBeenLastCalledWith({ __kos: "deck-do", action: "go", index: 3 }, "*");
    // The focus goes back to the menu it was opened from.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "More" })));
  });

  it("ends presenting when the viewer is given another artifact, closing the audience window", async () => {
    const record = ART[2]!;
    const pitch = { record, kind: "html", page: { id: "pitch", title: "Garden pitch", kind: "deck", html: "<main data-deck><section>a</section></main>" } };
    const other = { record: { ...record, id: "other", title: "Other deck" }, kind: "html", page: { ...pitch.page, id: "other", title: "Other deck" } };
    vi.spyOn(api, "anyPage").mockImplementation((id: string) => Promise.resolve((id === "pitch" ? pitch : other) as never));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const audience = { closed: false, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(audience as unknown as Window);
    const { rerender } = render(<ArtifactViewer id="pitch" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const el = await waitFor(() => {
      const f = document.querySelector<HTMLIFrameElement>("iframe.artifact-frame");
      if (!f) throw new Error("no frame yet");
      return f;
    });
    const pageWin = document.body.appendChild(document.createElement("iframe")).contentWindow!;
    Object.defineProperty(el.contentWindow!, "frames", { value: [pageWin], configurable: true });
    act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data: { __kos: "deck", index: 0, count: 4, hosted: true } })));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Present with notes" }));
    expect(screen.getByRole("dialog", { name: "Presenting Garden pitch" })).toBeTruthy();
    rerender(<ArtifactViewer id="other" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(audience.close).toHaveBeenCalled();
  });

  it("keeps its description and the rest in a menu the keyboard can walk", async () => {
    const record = ART[2]!;
    vi.spyOn(api, "anyPage").mockResolvedValue({ record: { ...record, description: "Why the garden, in six slides." }, kind: "html", page: { id: "pitch", title: "Garden pitch", kind: "deck", html: "<main data-deck><section>a</section></main>" } } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    render(<ArtifactViewer id="pitch" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const more = await screen.findByRole("button", { name: "More" });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More" });
    // The description is said about the menu, not one of its items.
    expect(within(menu).queryByText("Why the garden, in six slides.")).toBeNull();
    expect(menu.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(menu.getAttribute("aria-describedby")!)!.textContent).toBe("Why the garden, in six slides.");
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(more);
  });

  it("draws the doc as saved on Back to current after a save and a preview, so the next save keeps the edit", async () => {
    const record = { ...ART[3]!, artifactKind: "doc" as const };
    const savedAt = record.updatedAt + 500;
    const opened = { record, kind: "html", page: { id: "ledger", title: "Ledger", kind: "doc", html: "<p>first draft</p>" } };
    const newest = { record: { ...record, updatedAt: savedAt }, kind: "html", page: { id: "ledger", title: "Ledger", kind: "doc", html: "<p>saved edit</p>" } };
    const read = vi.spyOn(api, "anyPage").mockResolvedValue(opened as never);
    vi.spyOn(api, "pageHistory").mockResolvedValue([
      { version: 1, at: at(90), title: "Ledger", kind: "html" },
      { version: 2, at: at(1), title: "Ledger", kind: "html" },
    ]);
    vi.spyOn(api, "pageVersion").mockResolvedValue({ id: "ledger", title: "Ledger", kind: "doc", html: "<p>first draft</p>" } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const save = vi.spyOn(api, "savePage").mockResolvedValue(newest.record);
    render(<ArtifactViewer id="ledger" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const frameOf = (): Promise<HTMLIFrameElement> =>
      waitFor(() => {
        const f = document.querySelector<HTMLIFrameElement>("iframe.artifact-frame");
        if (!f) throw new Error("no frame yet");
        return f;
      });
    /** The doc's frame, its page window standing in, saving its whole document after the dashboard's own Done. */
    const saveFrom = async (el: HTMLIFrameElement, id: number, doc: string): Promise<void> => {
      const pageWin = document.body.appendChild(document.createElement("iframe")).contentWindow!;
      Object.defineProperty(el.contentWindow!, "frames", { value: [pageWin], configurable: true });
      const say = (data: unknown): void => act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data })));
      // The owner's hand in the frame, over the bridge's channel, so the dashboard's Done opens a save.
      const gestures = new MessageChannel();
      act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data: { __kos: "gestures" }, ports: [gestures.port2] })));
      gestures.port1.postMessage(0);
      await new Promise((r) => setTimeout(r, 20));
      say({ __kos: "edit", editing: true, pending: true, status: "", bad: false });
      fireEvent.click(await screen.findByRole("button", { name: "Done" }));
      await act(async () => {
        say({ __kos: "call", id, method: "save", args: { edit: { doc } } });
        await Promise.resolve();
        await Promise.resolve();
      });
      say({ __kos: "edit", editing: false, pending: false, status: "Saved", bad: false });
    };
    await saveFrom(await frameOf(), 1, "<p>saved edit</p>");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // History, an older version previewed, then back: the newest is read, and drawn as it was saved.
    read.mockResolvedValue(newest as never);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const rows = within(await screen.findByRole("dialog", { name: "History" })).getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to current" }));
    await waitFor(() => expect((document.querySelector("iframe.artifact-frame") as HTMLIFrameElement).getAttribute("srcdoc")).toContain("saved edit"));
    expect(document.querySelector("iframe.artifact-frame")!.getAttribute("srcdoc")).not.toContain("first draft");
    // The next save is made on the saved version, from the frame that holds the edit.
    await saveFrom(await frameOf(), 2, "<p>saved edit, and more</p>");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![2]).toBe(savedAt);
  });

  it("restores on the version the doc's own last save made, not the one first opened", async () => {
    const record = { ...ART[3]!, artifactKind: "doc" as const };
    vi.spyOn(api, "anyPage").mockResolvedValue({ record, kind: "html", page: { id: "ledger", title: "Ledger", kind: "doc", html: "<p>x</p>" } } as never);
    vi.spyOn(api, "pageHistory").mockResolvedValue([
      { version: 1, at: at(90), title: "Ledger", kind: "html" },
      { version: 2, at: at(40), title: "Ledger", kind: "html" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const rollback = vi.spyOn(api, "pageRollback").mockResolvedValue(record);
    vi.spyOn(api, "savePage").mockResolvedValue({ ...record, updatedAt: record.updatedAt + 500 });
    render(<ArtifactViewer id="ledger" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const el = await waitFor(() => {
      const f = document.querySelector<HTMLIFrameElement>("iframe.artifact-frame");
      if (!f) throw new Error("no frame yet");
      return f;
    });
    const pageWin = document.body.appendChild(document.createElement("iframe")).contentWindow!;
    Object.defineProperty(el.contentWindow!, "frames", { value: [pageWin], configurable: true });
    const say = (data: unknown): void => act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data })));
    // An edit the owner typed is waiting when Restore is pressed: the doc finishes it, saved by the dashboard's own Done, then the restore names that version.
    const gestures = new MessageChannel();
    act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data: { __kos: "gestures" }, ports: [gestures.port2] })));
    gestures.port1.postMessage(0);
    await new Promise((r) => setTimeout(r, 20));
    say({ __kos: "edit", editing: true, pending: true, status: "", bad: false });
    // While editing, the head's row holds the editing and History waits in its menu.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
    const rows = within(await screen.findByRole("dialog", { name: "History" })).getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Restore" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Restore" })).getByRole("button", { name: "Restore" }));
    await act(async () => {
      say({ __kos: "call", id: 1, method: "save", args: { edit: { doc: "<p>y</p>" } } });
      await Promise.resolve();
      await Promise.resolve();
    });
    say({ __kos: "edit", editing: false, pending: false, status: "Saved", bad: false });
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("ledger", 1, record.updatedAt + 500));
  });

  it("finishes an open doc's editing before the dashboard moves elsewhere", async () => {
    const record = { ...ART[3]!, artifactKind: "doc" as const };
    vi.spyOn(api, "anyPage").mockResolvedValue({ record, kind: "html", page: { id: "ledger", title: "Ledger", kind: "doc", html: "<p>x</p>" } } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    render(<ArtifactViewer id="ledger" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const el = await waitFor(() => {
      const f = document.querySelector<HTMLIFrameElement>("iframe.artifact-frame");
      if (!f) throw new Error("no frame yet");
      return f;
    });
    const pageWin = document.body.appendChild(document.createElement("iframe")).contentWindow!;
    Object.defineProperty(el.contentWindow!, "frames", { value: [pageWin], configurable: true });
    const told = vi.spyOn(pageWin, "postMessage");
    const say = (data: unknown): void => act(() => void window.dispatchEvent(new MessageEvent("message", { source: pageWin, data })));
    say({ __kos: "edit", editing: true, pending: true, status: "", bad: false });
    let moved = false;
    const leaving = settleOpenViewers().then(() => (moved = true));
    expect(told).toHaveBeenCalledWith({ __kos: "edit-do", action: "done" }, "*");
    await Promise.resolve();
    expect(moved).toBe(false);
    say({ __kos: "edit", editing: false, pending: false, status: "Saved", bad: false });
    await leaving;
    expect(moved).toBe(true);
  });

  it("keeps its versions in a drawer, each older one with a way back, and opens its project", async () => {
    vi.spyOn(api, "anyPage").mockResolvedValue({ ...deck, record: ART[3]!, page: { ...deck.page, id: "ledger", kind: "sheet" as const } } as never);
    vi.spyOn(api, "pageHistory").mockResolvedValue([
      { version: 1, at: at(90), title: "Ledger", kind: "html" },
      { version: 2, at: at(40), title: "Ledger", kind: "html" },
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const rollback = vi.spyOn(api, "pageRollback").mockResolvedValue(ART[3]!);
    const toProject = vi.fn();
    render(<ArtifactViewer id="ledger" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} onOpenOwner={toProject} />);
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    const drawer = await screen.findByRole("dialog", { name: "History" });
    const rows = within(within(drawer).getByRole("list", { name: "Versions" })).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("strong")?.textContent)).toEqual(["Version 2", "Version 1"]);
    expect(within(rows[0]!).getByText("Current")).toBeTruthy();
    // An older version can be looked at first, with nothing in it saved, then restored from there.
    const older = vi.spyOn(api, "pageVersion").mockResolvedValue({ id: "ledger", title: "Ledger", kind: "sheet", html: "<p>old</p>" });
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/Looking at version 1/)).toBeTruthy();
    expect(older).toHaveBeenCalledWith("ledger", 1);
    await waitFor(() => expect(document.querySelector("iframe.artifact-frame")?.getAttribute("srcdoc")).toContain("data-locked"));
    // Back to current reads the artifact again, so what was saved before the preview is what comes back, never the version first opened.
    const reads = (api.anyPage as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Back to current" }));
    await waitFor(() => expect((api.anyPage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(reads + 1));
    await waitFor(() => expect(screen.queryByText(/Looking at version 1/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(within(within(await screen.findByRole("dialog", { name: "History" })).getAllByRole("listitem")[1]!).getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/Looking at version 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    // Restored on the version it was opened at, so one saved since is a conflict, not an overwrite.
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("ledger", 1, ART[3]!.updatedAt));
    await waitFor(() => expect(screen.queryByText(/Looking at version 1/)).toBeNull());
    // Or restored from the drawer itself.
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const again = within(await screen.findByRole("dialog", { name: "History" })).getAllByRole("listitem");
    fireEvent.click(within(again[1]!).getByRole("button", { name: "Restore" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Restore" })).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledTimes(2));
    // A restore refused as a conflict says so.
    rollback.mockRejectedValueOnce(new Error("This artifact changed after it was opened"));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const third = within(await screen.findByRole("dialog", { name: "History" })).getAllByRole("listitem");
    fireEvent.click(within(third[1]!).getByRole("button", { name: "Restore" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Restore" })).getByRole("button", { name: "Restore" }));
    expect((await screen.findByText(/changed after it was opened/)).textContent).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Household budget" }));
    await waitFor(() => expect(toProject).toHaveBeenCalledWith({ project: "budget" }));
    expect(screen.queryByRole("button", { name: "Present" })).toBeNull();
  });

  it("sends a blob's artifact's request to the blob's thread, and opens the blob", async () => {
    const record = { id: "notes", projectSlug: null, blob: "noter", title: "Notes", path: "", updatedAt: at(1), kind: "html" as const, artifactKind: "doc" as const };
    vi.spyOn(api, "anyPage").mockResolvedValue({ record, kind: "html", page: { id: "notes", title: "Notes", kind: "doc", html: "<article data-doc></article>" } } as never);
    vi.spyOn(api, "pageHistory").mockResolvedValue([]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const sent = vi.spyOn(api, "message").mockResolvedValue({ reply: "" } as never);
    const opened = vi.fn();
    const toOwner = vi.fn();
    render(<ArtifactViewer id="notes" projects={projects} onBack={() => undefined} onOpenChat={opened} onOpenOwner={toOwner} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open noter" }));
    await waitFor(() => expect(toOwner).toHaveBeenCalledWith({ blob: "noter" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit with KOS" }));
    fireEvent.change(screen.getByLabelText(/What should change/), { target: { value: "Shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask KOS" }));
    expect(sent.mock.calls[0]?.[1]).toBe("agent:noter");
    expect(opened).toHaveBeenCalledWith({ blob: "noter" });
  });

  it("does not offer presenting for a doc, and sends a project's request to its own chat", async () => {
    const doc = { record: { ...ART[0]!, artifactKind: "doc" as const }, kind: "html" as const, page: { id: "spend", title: "Spending board", kind: "doc" as const, html: "<article data-doc></article>" } };
    vi.spyOn(api, "anyPage").mockResolvedValue(doc as never);
    vi.spyOn(api, "pageHistory").mockResolvedValue([]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));
    const sent = vi.spyOn(api, "message").mockResolvedValue({ reply: "" } as never);
    render(<ArtifactViewer id="spend" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    await screen.findByText("Spending board");
    expect(screen.queryByRole("button", { name: "Present" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit with KOS" }));
    fireEvent.change(screen.getByLabelText(/What should change/), { target: { value: "Shorter" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask KOS" }));
    expect(sent.mock.calls[0]?.[1]).toBe("project:budget");
  });

  it("says a widget page is an older one, and asks its project's chat to convert it", async () => {
    const record = { id: "old", projectSlug: "budget", title: "Old board", path: "", updatedAt: at(1), kind: "spec" as const, artifactKind: "page" as const };
    vi.spyOn(api, "anyPage").mockResolvedValue({ record, kind: "spec", spec: { id: "old", title: "Old board", widgets: [] }, data: {}, errors: {} } as never);
    vi.spyOn(api, "pageHistory").mockResolvedValue([]);
    const sent = vi.spyOn(api, "message").mockResolvedValue({ reply: "" } as never);
    const opened = vi.fn();
    render(<ArtifactViewer id="old" projects={projects} onBack={() => undefined} onOpenChat={opened} />);
    expect(await screen.findByText("This is an older widget page; open it from its project.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit with KOS" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Convert with KOS" }));
    expect(sent).toHaveBeenCalledWith(convertRequest(record), "project:budget");
    expect(sent.mock.calls[0]?.[0]).toMatch(/@page:old.*artifacts\.get.*artifacts\.write as HTML under the same id/);
    expect(opened).toHaveBeenCalledWith({ project: "budget" });
  });
});

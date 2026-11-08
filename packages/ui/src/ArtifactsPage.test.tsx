// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api, type ArtifactSummary, type Project } from "./api.js";
import { ArtifactViewer, ArtifactsPage, NEW_ARTIFACT_WORDS, chatOf, convertRequest, editRequest } from "./ArtifactsPage.js";
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

const titles = (): string[] => within(screen.getByRole("list", { name: "Artifacts" })).getAllByRole("button").map((b) => b.querySelector(".artifact-card-title")?.textContent ?? "");

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
    expect(screen.getByRole("button", { name: "Decks0" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titles()).toHaveLength(4);
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
    fireEvent.click(screen.getByRole("button", { name: "By project" }));
    const inGroup = (name: string): string[] => within(screen.getByRole("list", { name })).getAllByRole("button").map((b) => b.querySelector(".artifact-card-title")?.textContent ?? "");
    expect(inGroup("Household budget")).toEqual(["Spending board", "Ledger"]);
    // The workspace's own come last.
    expect(inGroup("Workspace")).toEqual(["Q4 brief", "Garden pitch"]);
    const heads = [...container.querySelectorAll(".artifact-group > .label")].map((h) => h.textContent);
    expect(heads).toEqual(["Household budget2", "Workspace2"]);
  });

  it("starts a new artifact in KOS's root chat, with the words to finish", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([]);
    const started = vi.fn();
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} onNew={started} />);
    await screen.findByText("Nothing made yet");
    // In the head, and beside the empty gallery.
    const buttons = screen.getAllByRole("button", { name: "New artifact" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(started).toHaveBeenCalledWith(NEW_ARTIFACT_WORDS);
    expect(NEW_ARTIFACT_WORDS).toBe("Make a ");
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
    expect(within(screen.getByText("Old board").closest("button")!).getByText("Older widget page")).toBeTruthy();
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
    // The request went to KOS at the root, so that is the chat opened, not the chat list.
    expect(chatOf(null)).toEqual({ name: "chats", id: "primary:owner" });
    expect(hrefFor(chatOf(null))).toBe(hrefFor({ name: "chats", id: "primary:owner" }));
    expect(chatOf({ project: "budget" })).toEqual({ name: "project", slug: "budget" });
    expect(chatOf({ blob: "noter" })).toEqual({ name: "blobs", blob: "noter" });
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

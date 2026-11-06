// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api, type ArtifactSummary, type Project } from "./api.js";
import { ArtifactViewer, ArtifactsPage, editRequest } from "./ArtifactsPage.js";
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

    fireEvent.click(screen.getByRole("button", { name: "Decks" }));
    expect(titles()).toEqual(["Garden pitch"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Search artifacts"), { target: { value: "totals by category" } });
    expect(titles()).toEqual(["Ledger"]);
    fireEvent.change(screen.getByLabelText("Search artifacts"), { target: { value: "nothing like this" } });
    expect(screen.getByText("No artifact matches these filters.")).toBeTruthy();
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

  it("tells the workspace from a project whose slug is workspace", async () => {
    const mine = { id: "plan", projectSlug: "workspace", title: "Office plan", path: "", updatedAt: at(2), kind: "html", artifactKind: "page", capturedAt: at(1) } as ArtifactSummary;
    vi.spyOn(api, "artifacts").mockResolvedValue([mine, ...ART]);
    vi.spyOn(api, "checkArtifact").mockResolvedValue({ findings: [], capturedAt: Date.now() });
    render(<ArtifactsPage projects={[...projects, { slug: "workspace", name: "Office" } as Project]} onOpen={() => undefined} />);
    await waitFor(() => expect(titles()).toHaveLength(5));
    const choose = (label: string): void => {
      fireEvent.click(screen.getByRole("button", { name: "Project" }));
      fireEvent.click(screen.getByRole("option", { name: label }));
    };
    choose("Office");
    expect(titles()).toEqual(["Office plan"]);
    choose("Workspace");
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
});

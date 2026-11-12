// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { api, dispositionName, type AgentInfo, type ArtifactSummary, type Project } from "./api.js";
import { emptyWords } from "./ArtifactManage.js";
import { ArtifactViewer, ArtifactsPage } from "./ArtifactsPage.js";
import { ArtifactOpen, ArtifactStep } from "./ArtifactStep.js";

beforeAll(() => {
  window.matchMedia ??= (() => ({ addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const projects = [
  { slug: "budget", name: "Household budget" },
  { slug: "garden", name: "Garden" },
  { slug: "maintenance", name: "Maintenance", type: "system" },
] as Project[];
const at = (n: number): number => Date.now() - n * 60_000;
const BRIEF: ArtifactSummary = { id: "brief", projectSlug: "budget", title: "Q4 brief", description: "What we decided and why.", path: "", updatedAt: at(10), kind: "html", artifactKind: "doc", capturedAt: at(1) };
const PITCH: ArtifactSummary = { id: "pitch", projectSlug: null, title: "Garden pitch", path: "", updatedAt: at(30), kind: "html", artifactKind: "deck", capturedAt: at(1) };
const OLD: ArtifactSummary = { id: "old", projectSlug: null, title: "Old memo", path: "", updatedAt: at(90), kind: "html", artifactKind: "doc", capturedAt: at(80), trashedAt: at(3) };

/** The frame's documents load from the dashboard's build; any answer will do here. */
const frames = (): void => void vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/javascript" } }));

function openViewer(record: ArtifactSummary, onBack = vi.fn()): void {
  vi.spyOn(api, "anyPage").mockResolvedValue({ record, kind: "html", page: { id: record.id, title: record.title, kind: record.artifactKind, html: "<article data-doc><p>x</p></article>" } } as never);
  frames();
  render(<ArtifactViewer id={record.id} projects={projects} onBack={onBack} onOpenChat={() => undefined} />);
}

/** The titles in a list of cards or rows, in order. */
const cards = (list = "Artifacts"): string[] => [...screen.getByRole("list", { name: list }).querySelectorAll(".artifact-card-title")].map((t) => t.textContent ?? "");

async function menuItem(name: string, more = "More"): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: more }));
  return within(screen.getByRole("menu")).getByRole("menuitem", { name });
}

describe("managing an artifact from its viewer", () => {
  it("renames it in a small dialog, title and description, and shows the new title", async () => {
    openViewer(BRIEF);
    const renamed = vi.spyOn(api, "renameArtifact").mockResolvedValue({ ...BRIEF, title: "Q4 decisions", description: "Each decision, with why.", updatedAt: Date.now() });
    fireEvent.click(await menuItem("Rename…"));
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    const title = within(dialog).getByLabelText("Title") as HTMLInputElement;
    expect(title.value).toBe("Q4 brief");
    fireEvent.change(title, { target: { value: "  Q4 decisions " } });
    fireEvent.change(within(dialog).getByLabelText(/Description/), { target: { value: "Each decision, with why." } });
    fireEvent.change(title, { target: { value: " " } });
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(title, { target: { value: "  Q4 decisions " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(renamed).toHaveBeenCalledWith("brief", { title: "Q4 decisions", description: "Each decision, with why." }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Q4 decisions" })).toBeTruthy();
  });

  it("renames an older widget page by its title alone, with no description to send", async () => {
    const spec = { ...BRIEF, id: "old-board", title: "Old board", kind: "spec" as const, artifactKind: "page" as const, description: undefined };
    vi.spyOn(api, "anyPage").mockResolvedValue({ record: spec, kind: "spec", spec: { id: "old-board", title: "Old board", widgets: [] }, data: [], errors: [] } as never);
    frames();
    render(<ArtifactViewer id="old-board" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const renamed = vi.spyOn(api, "renameArtifact").mockResolvedValue({ ...spec, title: "Board" });
    fireEvent.click(await menuItem("Rename…"));
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    expect(within(dialog).queryByLabelText(/Description/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Board" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(renamed).toHaveBeenCalledWith("old-board", { title: "Board" }));
  });

  it("sends only what changed", async () => {
    openViewer(BRIEF);
    const renamed = vi.spyOn(api, "renameArtifact").mockResolvedValue({ ...BRIEF, description: "New words." });
    fireEvent.click(await menuItem("Rename…"));
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    fireEvent.change(within(dialog).getByLabelText(/Description/), { target: { value: "New words." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(renamed).toHaveBeenCalledWith("brief", { description: "New words." }));
  });

  it("moves it to any project, the workspace or a living blob, the one it is in marked and not offered", async () => {
    openViewer(BRIEF);
    vi.spyOn(api, "agents").mockResolvedValue({ agents: [{ name: "noter" } as AgentInfo], invalid: [] });
    const moved = vi.spyOn(api, "moveArtifact").mockResolvedValue({ ...BRIEF, projectSlug: null, blob: "noter" });
    fireEvent.click(await menuItem("Move to…"));
    const dialog = await screen.findByRole("dialog", { name: "Move “Q4 brief”" });
    const picker = within(dialog).getByRole("radiogroup", { name: "Move to" });
    await within(picker).findByRole("radio", { name: /noter/ });
    expect(within(picker).getAllByRole("radio").map((r) => r.querySelector(".artifact-move-name")?.textContent)).toEqual(["Workspace", "Garden", "Household budget", "noter"]);
    // The projects and the blobs each a group under its name.
    expect(within(within(picker).getByRole("group", { name: "Blobs" })).getAllByRole("radio").map((r) => r.textContent)).toEqual(["noter"]);
    expect(within(picker).getByRole("group", { name: "Projects" })).toBeTruthy();
    const here = within(picker).getByRole("radio", { name: /Household budget/ }) as HTMLButtonElement;
    expect(here.disabled).toBe(true);
    expect(here.textContent).toContain("Here now");
    const move = within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    fireEvent.click(within(picker).getByRole("radio", { name: "Workspace" }));
    fireEvent.click(within(picker).getByRole("radio", { name: /noter/ }));
    expect(within(picker).getByRole("radio", { name: /noter/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(move);
    await waitFor(() => expect(moved).toHaveBeenCalledWith("brief", { blob: "noter" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("walks the move picker with the arrows, one tab stop, choosing as it goes", async () => {
    openViewer(BRIEF);
    vi.spyOn(api, "agents").mockResolvedValue({ agents: [{ name: "noter" } as AgentInfo], invalid: [] });
    fireEvent.click(await menuItem("Move to…"));
    const picker = within(await screen.findByRole("dialog", { name: "Move “Q4 brief”" })).getByRole("radiogroup", { name: "Move to" });
    await within(picker).findByRole("radio", { name: /noter/ });
    const radio = (name: RegExp): HTMLElement => within(picker).getByRole("radio", { name });
    const stops = (): string[] => within(picker).getAllByRole("radio").filter((r) => r.tabIndex === 0).map((r) => r.textContent ?? "");
    expect(stops()).toEqual(["Workspace"]);
    radio(/Workspace/).focus();
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(document.activeElement).toBe(radio(/Garden/));
    expect(radio(/Garden/).getAttribute("aria-checked")).toBe("true");
    // Where it is now is passed over.
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(document.activeElement).toBe(radio(/noter/));
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expect(document.activeElement).toBe(radio(/Workspace/));
    fireEvent.keyDown(picker, { key: "End" });
    expect(document.activeElement).toBe(radio(/noter/));
    fireEvent.keyDown(picker, { key: "ArrowUp" });
    expect(document.activeElement).toBe(radio(/Garden/));
    expect(stops()).toEqual([expect.stringContaining("Garden")]);
  });

  it("lets go of a place its search hides, so Move goes nowhere unseen", async () => {
    openViewer(BRIEF);
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `blob${i}` }) as AgentInfo);
    vi.spyOn(api, "agents").mockResolvedValue({ agents: many, invalid: [] });
    fireEvent.click(await menuItem("Move to…"));
    const dialog = await screen.findByRole("dialog", { name: "Move “Q4 brief”" });
    fireEvent.click(await within(dialog).findByRole("radio", { name: /blob3/ }));
    const move = within(dialog).getByRole("button", { name: "Move" }) as HTMLButtonElement;
    expect(move.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Find a place"), { target: { value: "garden" } });
    await waitFor(() => expect(move.disabled).toBe(true));
    fireEvent.change(within(dialog).getByLabelText("Find a place"), { target: { value: "" } });
    expect(within(dialog).getByRole("radio", { name: /blob3/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("makes a copy and offers to open it", async () => {
    openViewer(BRIEF);
    vi.spyOn(api, "duplicateArtifact").mockResolvedValue({ ...BRIEF, id: "brief-copy", title: "Q4 brief copy" });
    fireEvent.click(await menuItem("Duplicate"));
    expect(await screen.findByText("Made a copy: “Q4 brief copy”.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the copy" }).getAttribute("href")).toContain("brief-copy");
  });

  it("puts it in the trash, then says so over it with Restore and Delete forever, and nothing to edit or ask", async () => {
    const back = vi.fn();
    openViewer(BRIEF, back);
    vi.spyOn(api, "trashArtifact").mockResolvedValue({ ...BRIEF, trashedAt: Date.now() });
    fireEvent.click(await menuItem("Move to trash"));
    const notice = await screen.findByText(/This artifact is in the trash/);
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit with KOS" })).toBeNull();
    // The menu now holds the way back too.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(expect.arrayContaining(["Restore", "Delete forever"]));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    // Delete forever asks once, beside itself.
    const gone = vi.spyOn(api, "deleteArtifact").mockResolvedValue({ id: "brief", deleted: true });
    const box = notice.closest(".artifact-trashed") as HTMLElement;
    fireEvent.click(within(box).getByRole("button", { name: "Delete forever" }));
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).toMatch(/Delete “Q4 brief” for good, with every version\? This cannot be undone/);
    fireEvent.click(within(ask).getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(gone).toHaveBeenCalledWith("brief"));
    await waitFor(() => expect(back).toHaveBeenCalled());
  });

  it("restores one opened from the trash", async () => {
    openViewer(OLD);
    const restored = vi.spyOn(api, "restoreArtifact").mockResolvedValue({ ...OLD, trashedAt: undefined } as never);
    const box = (await screen.findByText(/This artifact is in the trash/)).closest(".artifact-trashed") as HTMLElement;
    fireEvent.click(within(box).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restored).toHaveBeenCalledWith("old"));
    await waitFor(() => expect(screen.queryByText(/This artifact is in the trash/)).toBeNull());
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
  });
});

describe("exporting an artifact", () => {
  const SHEET: ArtifactSummary = { id: "spend", projectSlug: "budget", title: "Spending", path: "", updatedAt: at(5), kind: "html", artifactKind: "sheet", capturedAt: at(1) };
  const labels = (): string[] => within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent ?? "");

  it("offers a doc's formats in its viewer's menu, and says so while the file is made", async () => {
    openViewer(BRIEF);
    let finish = (): void => undefined;
    const made = vi.spyOn(api, "exportArtifact").mockImplementation(() => new Promise<void>((done) => (finish = done)));
    fireEvent.click(await menuItem("Export as PDF"));
    await waitFor(() => expect(made).toHaveBeenCalledWith("brief", "pdf", { theme: "light" }));
    expect(screen.getByText("Exporting “Q4 brief” as PDF").closest("[role=status]")).toBeTruthy();
    finish();
    await waitFor(() => expect(screen.queryByText("Exporting “Q4 brief” as PDF")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(labels()).toEqual(expect.arrayContaining(["Export as PDF", "Export as Markdown", "Export as HTML"]));
    expect(labels()).not.toContain("Export as CSV");
  });

  it("draws an HTML export in the dashboard's theme, and shows why one failed", async () => {
    document.documentElement.dataset.theme = "light";
    openViewer(BRIEF);
    vi.spyOn(api, "exportArtifact").mockRejectedValue(new Error("the export took too long"));
    fireEvent.click(await menuItem("Export as HTML"));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not export “Q4 brief”: the export took too long");
    expect(api.exportArtifact).toHaveBeenCalledWith("brief", "html", { theme: "light" });
    delete document.documentElement.dataset.theme;
  });

  it("offers a deck no Markdown, a sheet each of its tabs, and a gallery card the sheet as one", async () => {
    vi.spyOn(api, "anyPage").mockResolvedValue({
      record: SHEET,
      kind: "html",
      page: { id: "spend", title: "Spending", kind: "sheet", html: `<script type="application/json" data-sheet>{"sheets":[{"name":"Expenses","columns":[{"label":"a"}],"rows":[]},{"name":"By month","columns":[{"label":"a"}],"rows":[]}]}</script>` },
    } as never);
    frames();
    render(<ArtifactViewer id="spend" projects={projects} onBack={() => undefined} onOpenChat={() => undefined} />);
    const made = vi.spyOn(api, "exportArtifact").mockResolvedValue();
    fireEvent.click(await menuItem("Export “By month” as CSV"));
    await waitFor(() => expect(made).toHaveBeenCalledWith("spend", "csv", { tab: "By month", theme: "dark" }));
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(labels().filter((l) => l.startsWith("Export"))).toEqual(["Export all tabs as CSV", "Export “Expenses” as CSV", "Export “By month” as CSV", "Export as HTML"]);
    cleanup();

    vi.spyOn(api, "artifacts").mockResolvedValue([PITCH, SHEET]);
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD]);
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Garden pitch" }));
    expect(labels().filter((l) => l.startsWith("Export"))).toEqual(["Export as PDF", "Export as HTML"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(await menuItem("Export as CSV", "Actions for Spending"));
    await waitFor(() => expect(made).toHaveBeenCalledWith("spend", "csv", { theme: "dark" }));
  });

  it("offers nothing to export from the trash", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([BRIEF]);
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD]);
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trash1" }));
    // A row in the trash holds only its way back and its way out.
    const row = within(screen.getByRole("list", { name: "Trash" })).getByRole("listitem");
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Old memoDocWorkspace3 minutes ago", "Restore", "Delete forever"]);
  });

  it("names the file as the server does, in full when it says so in UTF-8", () => {
    expect(dispositionName(`attachment; filename="Caf_ plan.pdf"; filename*=UTF-8''Caf%C3%A9%20plan.pdf`)).toBe("Café plan.pdf");
    expect(dispositionName('attachment; filename="plan.md"')).toBe("plan.md");
    expect(dispositionName(`attachment; filename="x.csv"; filename*=UTF-8''%E0%A4%A`)).toBe("x.csv");
    expect(dispositionName(null)).toBeUndefined();
  });
});

describe("the gallery's trash", () => {

  it("trashes from a card's menu, with an undo, and keeps it in a view of its own", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([BRIEF, PITCH]);
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD]);
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    await waitFor(() => expect(cards()).toEqual(["Q4 brief", "Garden pitch"]));
    const trashButton = screen.getByRole("button", { name: /^Trash/ });
    expect(trashButton.textContent).toBe("Trash1");

    vi.spyOn(api, "trashArtifact").mockResolvedValue({ ...PITCH, trashedAt: Date.now() });
    fireEvent.click(await menuItem("Move to trash", "Actions for Garden pitch"));
    await waitFor(() => expect(cards()).toEqual(["Q4 brief"]));
    expect(screen.getByText("“Garden pitch” is in the trash.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Trash/ }).textContent).toBe("Trash2");
    // Undo brings it back where it was.
    vi.spyOn(api, "restoreArtifact").mockResolvedValue(PITCH);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(cards()).toEqual(["Q4 brief", "Garden pitch"]));
    expect(screen.queryByText("“Garden pitch” is in the trash.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Trash/ }));
    expect(screen.getByRole("heading", { name: /^Trash/ })).toBeTruthy();
    expect(cards("Trash")).toEqual(["Old memo"]);
    expect(screen.getByTitle("When it was moved to the trash").textContent).toBe("3 minutes ago");
    fireEvent.click(screen.getByRole("button", { name: "Back to artifacts" }));
    expect(cards()).toEqual(["Q4 brief", "Garden pitch"]);
  });

  it("restores or deletes for good from the trash, asking before it deletes", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([BRIEF]);
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD]);
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trash1" }));
    const gone = vi.spyOn(api, "deleteArtifact").mockResolvedValue({ id: "old", deleted: true });
    // Each row holds its own Restore and Delete forever.
    fireEvent.click(within(screen.getByRole("list", { name: "Trash" })).getByRole("button", { name: "Delete forever" }));
    expect(gone).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete forever" }));
    await waitFor(() => expect(gone).toHaveBeenCalledWith("old"));
    expect(await screen.findByText("The trash is empty")).toBeTruthy();
    expect(screen.getByText(/Nothing is deleted on its own/)).toBeTruthy();
  });

  it("brings one back from its row in the trash, into the gallery", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([BRIEF]);
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD]);
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trash1" }));
    vi.spyOn(api, "restoreArtifact").mockResolvedValue({ ...OLD, trashedAt: undefined } as never);
    fireEvent.click(screen.getByRole("button", { name: "Restore Old memo" }));
    expect(await screen.findByText("The trash is empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to artifacts" }));
    expect(cards()).toEqual(["Q4 brief", "Old memo"]);
  });
});

describe("emptying the trash", () => {
  const MEMO: ArtifactSummary = { ...OLD, id: "memo", title: "Spare memo", trashedAt: at(5) };

  it("deletes everything in it for good, asking once first, and says so", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([BRIEF]);
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD, MEMO]);
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trash2" }));
    const gone = vi.spyOn(api, "deleteArtifact").mockImplementation((id) => Promise.resolve({ id, deleted: true }));
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    expect(gone).not.toHaveBeenCalled();
    const ask = await screen.findByRole("alertdialog");
    expect(ask.textContent).toContain("Delete all 2 artifacts in the trash for good");
    fireEvent.click(within(ask).getByRole("button", { name: "Empty trash" }));
    await waitFor(() => expect(gone.mock.calls.map((c) => c[0])).toEqual(["old", "memo"]));
    expect(await screen.findByText("The trash is empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Empty trash" })).toBeNull();
    expect(screen.getByRole("heading", { name: /^Trash/ }).textContent).toBe("Trash0");
    fireEvent.click(screen.getByRole("button", { name: "Back to artifacts" }));
    expect(cards()).toEqual(["Q4 brief"]);
    // The way back to the trash no longer counts what went.
    expect(screen.getByRole("button", { name: /^Trash/ }).textContent).toBe("Trash");
  });

  it("says it empties what the filters hide too", async () => {
    vi.spyOn(api, "artifacts").mockResolvedValue([BRIEF]);
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD, MEMO]);
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trash2" }));
    fireEvent.change(screen.getByLabelText("Search the trash"), { target: { value: "spare" } });
    expect(cards("Trash")).toEqual(["Spare memo"]);
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Delete all 2 artifacts in the trash for good, including 1 your filters hide? Every version goes with them. This cannot be undone.");
  });

  it("says one in the trash as one", () => {
    expect(emptyWords(1)).toBe("Delete the one artifact in the trash for good? Every version goes with it. This cannot be undone.");
    expect(emptyWords(1, 1)).toBe("Delete the one artifact in the trash for good, though your filters hide it? Every version goes with it. This cannot be undone.");
    expect(emptyWords(3)).toBe("Delete all 3 artifacts in the trash for good? Every version goes with them. This cannot be undone.");
  });

  it("stops at the first that cannot be deleted, keeping it and the rest, and says why", async () => {
    const LAST: ArtifactSummary = { ...OLD, id: "last", title: "Last memo", trashedAt: at(7) };
    vi.spyOn(api, "artifacts").mockResolvedValue([BRIEF]);
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD, MEMO, LAST]);
    render(<ArtifactsPage projects={projects} onOpen={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Trash3" }));
    const gone = vi.spyOn(api, "deleteArtifact").mockImplementation((id) => (id === "memo" ? Promise.reject(new Error("the disk is read-only")) : Promise.resolve({ id, deleted: true })));
    fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Empty trash" }));
    expect((await screen.findByRole("alert")).textContent).toBe("the disk is read-only");
    // The first went, the second failed, and the third was never tried.
    expect(gone.mock.calls.map((c) => c[0])).toEqual(["old", "memo"]);
    expect(cards("Trash")).toEqual(["Spare memo", "Last memo"]);
    expect(screen.getByRole("heading", { name: /^Trash/ }).textContent).toBe("Trash2");
  });
});

describe("an artifact a chat named, now in the trash", () => {
  it("says so on its card, with Restore for the owner", async () => {
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([OLD]);
    const restored = vi.spyOn(api, "restoreArtifact").mockResolvedValue({ ...OLD, trashedAt: undefined } as never);
    const { container } = render(
      <ArtifactOpen.Provider value={{ projects, open: () => undefined }}>
        <ArtifactStep art={{ id: "old", title: "Old memo", projectSlug: null, artifactKind: "doc" }} />
        <ArtifactStep art={{ id: "pitch", title: "Garden pitch", projectSlug: null, artifactKind: "deck" }} />
      </ArtifactOpen.Provider>,
    );
    expect(await screen.findByText("In the trash")).toBeTruthy();
    const [old, pitch] = [...container.querySelectorAll<HTMLElement>(".artifact-step")];
    expect(old!.classList.contains("is-trashed")).toBe(true);
    expect(pitch!.classList.contains("is-trashed")).toBe(false);
    expect(within(pitch!).queryByRole("button", { name: "Restore" })).toBeNull();
    vi.spyOn(api, "trashedArtifacts").mockResolvedValue([]);
    fireEvent.click(within(old!).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restored).toHaveBeenCalledWith("old"));
    await waitFor(() => expect(old!.classList.contains("is-trashed")).toBe(false));
  });
});

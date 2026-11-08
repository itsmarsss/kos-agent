// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, type PageSummary } from "./api.js";
import { ArtifactRail, ArtifactStrip, ownedBy, useOwnedArtifacts, type RailOwner } from "./ArtifactRail.js";

// The turn-end signal, held so a test can end a turn.
const ends = vi.hoisted(() => new Set<(id: string) => void>());
vi.mock("./progress.js", () => ({
  onTurnEnd: (listener: (id: string) => void) => {
    ends.add(listener);
    return () => ends.delete(listener);
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const at = (minutes: number): number => Date.now() - minutes * 60_000;
const items: PageSummary[] = [
  { id: "minutes", projectSlug: "garden", title: "Committee minutes", path: "", updatedAt: at(5), kind: "html", artifactKind: "doc" },
  { id: "ledger", projectSlug: "budget", title: "Ledger", path: "", updatedAt: at(90), kind: "html", artifactKind: "sheet" },
];

describe("a project's artifacts beside its chat", () => {
  it("lists each with its kind and time, marks the one open, and opens one on a click", () => {
    const open = vi.fn();
    render(<ArtifactRail items={items} open="ledger" onOpen={open} />);
    const rows = within(screen.getByRole("list", { name: "Artifacts" })).getAllByRole("button");
    expect(rows.map((r) => r.querySelector("strong")?.textContent)).toEqual(["Committee minutes", "Ledger"]);
    expect(rows[0]!.textContent).toMatch(/Doc, 5 minutes ago/);
    expect(rows[1]!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(rows[0]!);
    expect(open).toHaveBeenCalledWith(items[0]);
  });

  it("folds into one row under the chat on a narrow screen, opening to the same list", () => {
    const open = vi.fn();
    render(<ArtifactStrip items={items} onOpen={open} />);
    const row = screen.getByRole("button", { name: /Artifacts \(2\)/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    fireEvent.click(screen.getByText("Ledger"));
    expect(open).toHaveBeenCalledWith(items[1]);
  });

  it("says when there is nothing yet", () => {
    render(<ArtifactRail items={[]} onOpen={() => undefined} />);
    expect(screen.getByText(/No artifacts yet/)).toBeTruthy();
    cleanup();
    const { container } = render(<ArtifactStrip items={[]} onOpen={() => undefined} />);
    expect(container.textContent).toBe("");
  });
});

describe("what an owner owns", () => {
  const all: PageSummary[] = [
    ...items,
    { id: "notes", projectSlug: null, blob: "noter", title: "Notes", path: "", updatedAt: at(1), kind: "html", artifactKind: "doc" },
    { id: "memo", projectSlug: null, title: "Memo", path: "", updatedAt: at(2), kind: "html", artifactKind: "doc" },
    { id: "left", projectSlug: null, blob: "noter", blobId: "old", blobRemoved: true, title: "Left", path: "", updatedAt: at(3), kind: "html", artifactKind: "doc" },
  ];

  it("gives a blob only its own, and a project only its own, with no stand-in from elsewhere", () => {
    // What a removed blob of the same name left is not the living one's.
    expect(all.filter((a) => ownedBy({ blob: "noter" }, a)).map((a) => a.id)).toEqual(["notes"]);
    expect(all.filter((a) => ownedBy({ blob: "roster" }, a))).toEqual([]);
    expect(all.filter((a) => ownedBy({ project: "garden" }, a)).map((a) => a.id)).toEqual(["minutes"]);
  });

  it("reads the list when the owner changes or a turn ends, not on every render", async () => {
    const read = vi.spyOn(api, "artifacts").mockResolvedValue(all);
    const { result, rerender } = renderHook(({ owner }: { owner: RailOwner }) => useOwnedArtifacts(owner), { initialProps: { owner: { blob: "noter" } as RailOwner } });
    await waitFor(() => expect(result.current.map((a) => a.id)).toEqual(["notes"]));
    expect(read).toHaveBeenCalledTimes(1);
    // A new but equal owner, as a parent's render makes, reads nothing.
    rerender({ owner: { blob: "noter" } });
    expect(read).toHaveBeenCalledTimes(1);
    // A turn ending is what makes one, so the list is read again.
    act(() => ends.forEach((end) => end("agent:noter")));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    rerender({ owner: { project: "budget" } });
    await waitFor(() => expect(result.current.map((a) => a.id)).toEqual(["ledger"]));
  });
});

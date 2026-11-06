// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageSummary, Project } from "./api.js";
import { ArtifactRail, ArtifactStrip } from "./ArtifactRail.js";

afterEach(cleanup);

const projects = [
  { slug: "garden", name: "Garden Club" },
  { slug: "budget", name: "Household Budget" },
] as Project[];
const at = (minutes: number): number => Date.now() - minutes * 60_000;
const items: PageSummary[] = [
  { id: "minutes", projectSlug: "garden", title: "Committee minutes", path: "", updatedAt: at(5), kind: "html", artifactKind: "doc" },
  { id: "ledger", projectSlug: "budget", title: "Ledger", path: "", updatedAt: at(90), kind: "html", artifactKind: "sheet" },
];

describe("a project's artifacts beside its chat", () => {
  it("lists each with its kind and time, says whose one from another project is, and opens it on a click", () => {
    const open = vi.fn();
    render(<ArtifactRail items={items} home="garden" projects={projects} open="ledger" onOpen={open} />);
    const rows = within(screen.getByRole("list", { name: "Artifacts" })).getAllByRole("button");
    expect(rows.map((r) => r.querySelector("strong")?.textContent)).toEqual(["Committee minutes", "Ledger"]);
    expect(rows[0]!.textContent).toMatch(/Doc, 5 minutes ago/);
    // Its own project's goes unnamed; the other's says whose it is.
    expect(within(rows[0]!).queryByText("Garden Club")).toBeNull();
    expect(within(rows[1]!).getByText("Household Budget")).toBeTruthy();
    expect(rows[1]!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(rows[0]!);
    expect(open).toHaveBeenCalledWith(items[0]);
  });

  it("folds into one row under the chat on a narrow screen, opening to the same list", () => {
    const open = vi.fn();
    render(<ArtifactStrip items={items} home="garden" projects={projects} onOpen={open} />);
    const row = screen.getByRole("button", { name: /Artifacts \(2\)/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    fireEvent.click(screen.getByText("Ledger"));
    expect(open).toHaveBeenCalledWith(items[1]);
  });

  it("says when there is nothing yet", () => {
    render(<ArtifactRail items={[]} projects={projects} onOpen={() => undefined} />);
    expect(screen.getByText(/No artifacts yet/)).toBeTruthy();
    cleanup();
    const { container } = render(<ArtifactStrip items={[]} projects={projects} onOpen={() => undefined} />);
    expect(container.textContent).toBe("");
  });
});

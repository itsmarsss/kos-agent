// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MoveDialog } from "./MoveDialog.js";

afterEach(cleanup);

describe("Move to…", () => {
  it("offers no hidden folder, names places not slugs, marks where the file is, and puts Move last", () => {
    const onMove = vi.fn();
    render(
      <MoveDialog
        paths={["projects/garden/a.md"]}
        folders={[".", ".kos", ".kos/trash", "notes", "projects/garden", "projects/garden/beds", "blobs/plant-watcher"]}
        projects={[{ slug: "garden", name: "Garden", type: "project", status: "active", lastTouchedAt: 0 }]}
        onMove={onMove}
        onClose={() => {}}
      />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.querySelector(".place-name")?.textContent)).toEqual(["Workspace", "beds", "notes", "Garden", "Plant watcher"]);
    const here = radios[3]!;
    expect((here as HTMLButtonElement).disabled).toBe(true);
    expect(here.textContent).toContain("Here now");
    expect([...document.querySelectorAll(".sheet-foot button")].map((b) => b.textContent)).toEqual(["Cancel", "Move"]);
    fireEvent.click(screen.getByRole("radio", { name: /beds/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(onMove).toHaveBeenCalledWith("projects/garden/beds");
  });

  it("moves to a folder typed by its path", () => {
    const onMove = vi.fn();
    render(<MoveDialog paths={["a.md"]} folders={["."]} projects={[]} onMove={onMove} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^Or a folder by its path/), { target: { value: "/notes/deep/" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(onMove).toHaveBeenCalledWith("notes/deep");
  });
});

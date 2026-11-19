// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MoveDialog } from "./MoveDialog.js";

afterEach(cleanup);

describe("Move to…", () => {
  it("offers no hidden folder, names projects, marks where the file is, and puts Move last", () => {
    const onMove = vi.fn();
    render(
      <MoveDialog
        paths={["projects/garden/a.md"]}
        folders={[".", ".kos", ".kos/trash", "notes", "projects/garden", "projects/garden/beds"]}
        projects={[{ slug: "garden", name: "Garden", type: "project", status: "active", lastTouchedAt: 0 }]}
        onMove={onMove}
        onClose={() => {}}
      />,
    );
    const chips = screen.getAllByRole("button").filter((b) => b.classList.contains("file-dialog-folder"));
    expect(chips.map((b) => b.querySelector(".file-dialog-folder-name")?.textContent)).toEqual(["Workspace", "notes", "Garden", "Garden / beds"]);
    const here = chips[2]!;
    expect((here as HTMLButtonElement).disabled).toBe(true);
    expect(here.textContent).toContain("here now");
    const actions = [...document.querySelectorAll(".file-dialog-actions button")].map((b) => b.textContent);
    expect(actions).toEqual(["Cancel", "Move"]);
    fireEvent.click(chips[3]!);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(onMove).toHaveBeenCalledWith("projects/garden/beds");
  });
});

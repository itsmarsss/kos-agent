// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { api } from "./api.js";
import { EntryMenu, carriesPath, dragProps, dropProps, useFileOps, type Entry } from "./FileActions.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The handles on a file: a menu per row, a drag that only a folder takes,
 * and dialogs that ask before anything is lost. Desktop drops are someone
 * else's (the uploader's), so a folder must leave them alone.
 */

const file: Entry = { path: "projects/garden/notes.md", name: "notes.md", kind: "file" };
const folder: Entry = { path: "projects/garden/old", name: "old", kind: "dir" };

function Harness({ entry, inView = false, onChanged = () => {} }: { entry: Entry; inView?: boolean; onChanged?: () => void }): ReactElement {
  const ops = useFileOps({ onOpen: () => {}, onChanged, onError: () => {}, folders: ["projects/garden"] });
  return (
    <>
      <div data-testid="drop" {...dropProps(folder.path, ops)} />
      <EntryMenu entry={entry} ops={ops} inView={inView} />
      {ops.dialogs}
    </>
  );
}

function transfer(types: string[], data: Record<string, string> = {}): DataTransfer {
  return { types, getData: (t: string) => data[t] ?? "", setData: () => {}, dropEffect: "none", effectAllowed: "all", files: [] } as unknown as DataTransfer;
}

describe("a file's menu", () => {
  it("offers a file everything, a folder no download, and in its own view nothing to open", () => {
    const { unmount } = render(<Harness entry={file} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for notes.md" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Preview", "Download", "Rename", "Duplicate", "Move to…", "Delete"]);
    unmount();

    render(<Harness entry={folder} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for old" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Open", "Rename", "Duplicate", "Move to…", "Delete"]);
    cleanup();

    render(<Harness entry={file} inView />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for notes.md" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Rename", "Duplicate", "Move to…", "Delete"]);
  });

  it("asks before deleting and says what goes with a folder", () => {
    render(<Harness entry={folder} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for old" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText(/and everything in it/)).toBeTruthy();
  });

  it("renames to a new name beside the old one", async () => {
    const rename = vi.spyOn(api, "renameFile").mockResolvedValue({ path: "projects/garden/plan.md" });
    const changed = vi.fn();
    render(<Harness entry={file} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for notes.md" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByDisplayValue("notes.md");
    fireEvent.change(input, { target: { value: "plan.md" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(changed).toHaveBeenCalledWith({ op: "rename", from: "projects/garden/notes.md", path: "projects/garden/plan.md" }));
    expect(rename).toHaveBeenCalledWith("projects/garden/notes.md", "projects/garden/plan.md");
  });
});

describe("dragging a row onto a folder", () => {
  it("carries the path, and a folder takes it as a move", async () => {
    const rename = vi.spyOn(api, "renameFile").mockResolvedValue({ path: "projects/garden/old/notes.md" });
    render(<Harness entry={file} />);
    const dt = transfer(["application/x-kos-path"], { "application/x-kos-path": JSON.stringify(file) });
    const over = fireEvent.dragOver(screen.getByTestId("drop"), { dataTransfer: dt });
    expect(over).toBe(false); // default prevented: the drop is allowed
    fireEvent.drop(screen.getByTestId("drop"), { dataTransfer: dt });
    await waitFor(() => expect(rename).toHaveBeenCalledWith("projects/garden/notes.md", "projects/garden/old/notes.md"));
  });

  it("leaves a desktop file drop to the uploader", () => {
    const rename = vi.spyOn(api, "renameFile").mockResolvedValue({ path: "x" });
    render(<Harness entry={file} />);
    const dt = transfer(["Files"]);
    const over = fireEvent.dragOver(screen.getByTestId("drop"), { dataTransfer: dt });
    expect(over).toBe(true); // not prevented: not ours
    fireEvent.drop(screen.getByTestId("drop"), { dataTransfer: dt });
    expect(rename).not.toHaveBeenCalled();
    expect(carriesPath({ dataTransfer: dt } as never)).toBe(false);
  });

  it("marks a row draggable with its path", () => {
    const props = dragProps(file);
    expect(props.draggable).toBe(true);
    const set = vi.fn();
    props.onDragStart({ dataTransfer: { setData: set, effectAllowed: "" } } as never);
    expect(set).toHaveBeenCalledWith("application/x-kos-path", JSON.stringify(file));
  });
});

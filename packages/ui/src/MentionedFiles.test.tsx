// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { MentionedFiles, forgetMentioned, mentionedPaths } from "./MentionedFiles.js";

beforeEach(() => {
  forgetMentioned();
  (URL as unknown as { createObjectURL?: (b: Blob) => string }).createObjectURL ??= () => "blob:x";
  (URL as unknown as { revokeObjectURL?: (u: string) => void }).revokeObjectURL ??= () => undefined;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A message that mentions files gets a card per file under it: what it is,
 * how big, and a way to look at it or save it. A folder is told apart from
 * a file, and a path that no longer exists says so rather than pretending.
 */
describe("files mentioned in a message", () => {
  it("finds the distinct paths, bare or bracketed, in order", () => {
    expect(mentionedPaths("see @file:projects/a/plan.md and @file:[projects/a/My Notes.md], then @file:projects/a/plan.md again; @page:home is not a file")).toEqual([
      "projects/a/plan.md",
      "projects/a/My Notes.md",
    ]);
    expect(mentionedPaths("nothing here")).toEqual([]);
  });

  it("shows a file, a folder and a missing path each for what it is", async () => {
    vi.spyOn(api, "file").mockImplementation(async (path: string) => {
      if (path === "projects/a/plan.md") return { path, size: 2048, modifiedAt: 1, text: "# Plan", language: "markdown" };
      throw new Error("not a file");
    });
    vi.spyOn(api, "files").mockImplementation(async (path = ".") => {
      if (path === "projects/a/notes") return { path, entries: [{ name: "x", path: "projects/a/notes/x", kind: "file" as const, size: 1, modifiedAt: 1 }] };
      throw new Error("no such folder");
    });
    render(<MentionedFiles text="Wrote @file:projects/a/plan.md, see @file:projects/a/notes and @file:projects/a/gone.txt" />);
    expect(await screen.findByText("plan.md")).toBeTruthy();
    expect(screen.getByText("2.0 KB · markdown")).toBeTruthy();
    expect(screen.getByText("folder · 1 item")).toBeTruthy();
    expect(screen.getByText("not found")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download plan.md" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download notes" })).toBeNull();
    expect(decodeURIComponent(screen.getByRole("link", { name: "Open notes in Files" }).getAttribute("href") ?? "")).toContain("projects/a/notes");

    // Clicking the file opens the popup on it, with its text.
    fireEvent.click(screen.getByText("plan.md"));
    expect(await screen.findByRole("dialog", { name: "plan.md" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
  });

  it("draws nothing for a message with no file in it", () => {
    const { container } = render(<MentionedFiles text="just words and @page:home" />);
    expect(container.innerHTML).toBe("");
  });
});

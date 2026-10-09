// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { FilePreview } from "./FilePreview.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The popup shows the file for what it is, says where it sits among its
 * neighbours, and answers the keyboard: arrows step, Escape closes.
 */
describe("the file preview", () => {
  const siblings = ["projects/garden/a.md", "projects/garden/b.txt", "projects/garden/c.txt"];

  function open(path: string) {
    vi.spyOn(api, "file").mockImplementation(async (p: string) => ({
      path: p,
      size: 12,
      modifiedAt: Date.now() - 60_000,
      text: p.endsWith(".md") ? "# Plan\n\nTiles first." : "plain words",
      language: p.endsWith(".md") ? "markdown" : "text",
    }));
    const onStep = vi.fn();
    const onClose = vi.fn();
    render(<FilePreview path={path} siblings={siblings} onStep={onStep} onClose={onClose} actions={<button type="button">Download</button>} />);
    return { onStep, onClose };
  }

  it("renders markdown as a page and counts its place in the folder", async () => {
    open(siblings[0]!);
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "a.md" })).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect(screen.getByText("Download")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous file" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("steps with the arrows and the arrow keys, and closes on Escape", async () => {
    const h = open(siblings[1]!);
    expect(await screen.findByText("plain words")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(h.onStep).toHaveBeenCalledWith(siblings[2]);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(h.onStep).toHaveBeenCalledWith(siblings[0]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(h.onClose).toHaveBeenCalled();
  });

  it("shows nothing when no file is open", () => {
    render(<FilePreview path={null} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

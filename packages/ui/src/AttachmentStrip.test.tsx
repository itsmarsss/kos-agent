// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { AttachmentStrip } from "./AttachmentStrip.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("an attachment opens in the same window as a file", () => {
  it("shows a kept PDF as the file, with Raw for the words KOS reads out of it", async () => {
    const file = vi.spyOn(api, "file").mockResolvedValue({ path: "uploads/wout.pdf", size: 9, modifiedAt: 0, omitted: "binary", language: "" });
    const text = vi.spyOn(api, "fileText").mockResolvedValue({ path: "uploads/wout.pdf", text: "WEEKLY SCHEDULE", extracted: "pdf, 3 pages" });
    render(<AttachmentStrip items={[{ name: "wout.pdf", text: "[wout.pdf: 3 pages]", path: "uploads/wout.pdf" }]} />);
    fireEvent.click(screen.getByTitle("wout.pdf"));
    // The Files page's own window: framed, named, with its links.
    expect(screen.getByRole("dialog", { name: "wout.pdf" })).toBeTruthy();
    await waitFor(() => {
      if (!document.querySelector("iframe.preview-frame")) throw new Error("no viewer yet");
    });
    expect(file).toHaveBeenCalledWith("uploads/wout.pdf");
    expect(screen.getByText("Open in Files").getAttribute("href")).toBe("#/files/uploads%2Fwout.pdf");
    expect(screen.getByText("Download")).toBeTruthy();
    // Raw: the words, read out of the file itself rather than taken from the message.
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(await screen.findByText("WEEKLY SCHEDULE")).toBeTruthy();
    expect(text).toHaveBeenCalledWith("uploads/wout.pdf");
    expect(screen.getByText(/pdf, 3 pages/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(document.querySelector("iframe.preview-frame")).toBeTruthy();
  });

  it("shows a file that is only in the composer by its words, with nothing to fetch and no Raw", () => {
    const file = vi.spyOn(api, "file");
    render(<AttachmentStrip items={[{ name: "notes.txt", text: "just words" }]} onRemove={() => {}} />);
    fireEvent.click(screen.getByTitle("notes.txt"));
    expect(screen.getByRole("dialog", { name: "notes.txt" })).toBeTruthy();
    expect(screen.getByText("just words")).toBeTruthy();
    expect(file).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
    expect(screen.queryByText("Open in Files")).toBeNull();
  });
});

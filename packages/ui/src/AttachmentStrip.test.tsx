// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { AttachmentStrip } from "./AttachmentStrip.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("an attachment that was kept as a file", () => {
  it("opens as the file itself, with the words the model saw as the other view", async () => {
    const file = vi.spyOn(api, "file").mockResolvedValue({ path: "uploads/wout.pdf", size: 9, modifiedAt: 0, omitted: "binary", language: "" });
    render(<AttachmentStrip items={[{ name: "wout.pdf", text: "[wout.pdf: 3 pages]\nWEEKLY SCHEDULE", path: "uploads/wout.pdf" }]} />);
    fireEvent.click(screen.getByTitle("wout.pdf"));
    // The file: a PDF in the browser's viewer, fetched by its kept path.
    const frame = await waitFor(() => {
      const el = document.querySelector("iframe.preview-frame");
      if (!el) throw new Error("no viewer yet");
      return el;
    });
    expect(frame.getAttribute("src")).toContain("wout.pdf");
    expect(file).toHaveBeenCalledWith("uploads/wout.pdf");
    expect(screen.getByText("Open in Files").getAttribute("href")).toBe("#/files/uploads%2Fwout.pdf");
    // The other view: what the model was given.
    fireEvent.click(screen.getByText("Raw text"));
    expect(screen.getByText(/WEEKLY SCHEDULE/)).toBeTruthy();
  });

  it("shows the words alone when nothing was kept", () => {
    render(<AttachmentStrip items={[{ name: "notes.txt", text: "just words" }]} />);
    fireEvent.click(screen.getByTitle("notes.txt"));
    expect(screen.getByText("just words")).toBeTruthy();
    expect(screen.queryByText("Raw text")).toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
import { FileBody, FilePreview } from "./FilePreview.js";

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

  it("frames a PDF in the browser's viewer, and marks text read out of a document", () => {
    const { container, unmount } = render(<FileBody file={{ path: "docs/paper.pdf", size: 9, modifiedAt: 0, omitted: "binary", language: "" }} />);
    const frame = container.querySelector("iframe.preview-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/api/file/view?path=docs%2Fpaper.pdf");
    expect(frame.title).toBe("paper.pdf");
    unmount();
    render(<FileBody file={{ path: "cv.docx", size: 9, modifiedAt: 0, text: "Resume of Kenny", language: "", extracted: "docx, 1 paragraph" }} />);
    expect(screen.getByText(/Text read from the document \(docx, 1 paragraph\)/)).toBeTruthy();
    expect(screen.getByText("Resume of Kenny")).toBeTruthy();
  });

  it("shows a file that is not on disk under its own key, and steps among keys", () => {
    const file = vi.spyOn(api, "file");
    const onStep = vi.fn();
    const keys = ["attached:0:a.txt", "uploads/b.md"];
    render(
      <FilePreview path="attached:0:a.txt" siblings={keys} locals={{ "attached:0:a.txt": { name: "a.txt", text: "only here" } }} onStep={onStep} onClose={() => {}} />,
    );
    expect(screen.getByRole("dialog", { name: "a.txt" })).toBeTruthy();
    expect(screen.getByText("only here")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(file).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Next file"));
    expect(onStep).toHaveBeenCalledWith("uploads/b.md");
  });

  it("offers Raw for a document, shows the words, and comes back to the file", async () => {
    vi.spyOn(api, "file").mockResolvedValue({ path: "docs/paper.pdf", size: 9, modifiedAt: 0, omitted: "binary", language: "" });
    const text = vi.spyOn(api, "fileText").mockResolvedValue({ path: "docs/paper.pdf", text: "the words", extracted: "pdf, 2 pages" });
    render(<FilePreview path="docs/paper.pdf" onClose={() => {}} />);
    await waitFor(() => {
      if (!document.querySelector("iframe.preview-frame")) throw new Error("no viewer yet");
    });
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(await screen.findByText("the words")).toBeTruthy();
    expect(text).toHaveBeenCalledWith("docs/paper.pdf");
    expect(document.querySelector("iframe.preview-frame")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(document.querySelector("iframe.preview-frame")).toBeTruthy();
    // A plain text file has no other view.
    cleanup();
    vi.spyOn(api, "file").mockResolvedValue({ path: "notes.txt", size: 9, modifiedAt: 0, text: "plain", language: "text" });
    render(<FilePreview path="notes.txt" onClose={() => {}} />);
    expect(await screen.findByText("plain")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
  });

  it("shows nothing when no file is open", () => {
    render(<FilePreview path={null} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

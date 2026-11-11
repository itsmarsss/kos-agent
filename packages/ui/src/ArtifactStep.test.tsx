// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatEvent } from "./api.js";
import { ArtifactOpen, THUMB_RETRY_MS, writtenArtifact } from "./ArtifactStep.js";
import { ToolCall } from "./ToolCall.js";

afterEach(cleanup);

type Tool = Extract<ChatEvent, { kind: "tool" }>;
const record = { id: "brief", projectSlug: "garden", title: "Q4 brief", path: "projects/garden/pages/brief.html", updatedAt: 1700000000000, kind: "html", artifactKind: "doc", description: "What we decided." };
const write = (over: Partial<Tool> = {}): Tool => ({ kind: "tool", name: "artifacts.write", summary: "Write doc “Q4 brief”", args: { id: "brief", kind: "doc", title: "Q4 brief", html: "<article data-doc></article>" }, result: JSON.stringify(record), ...over });

describe("an artifact a turn wrote", () => {
  it("is read from the record the store kept, else from what was asked when the record was cut short", () => {
    expect(writtenArtifact(write())).toEqual({ id: "brief", title: "Q4 brief", artifactKind: "doc", projectSlug: "garden", updatedAt: record.updatedAt });
    // Cut short: its owner is still read from what survives of it.
    expect(writtenArtifact(write({ result: JSON.stringify(record).slice(0, 40) }))).toEqual({ id: "brief", title: "Q4 brief", artifactKind: "doc", projectSlug: "garden" });
    // Cut before its owner: the project the call named.
    expect(writtenArtifact(write({ result: JSON.stringify(record).slice(0, 12), args: { id: "brief", kind: "doc", title: "Q4 brief", project: "garden" } }))?.projectSlug).toBe("garden");
  });

  it("is read from a patch's summary line, before its check's words", () => {
    const line = JSON.stringify({ id: "brief", title: "Q4 brief", artifactKind: "doc", projectSlug: "garden", updatedAt: record.updatedAt, version: 3, edits: 1, replaced: 1 });
    const patch = (result: string): Tool => ({ kind: "tool", name: "artifacts.patch", summary: "Change artifact brief", args: { id: "brief", edits: [{ find: "a", replace: "b" }] }, result });
    expect(writtenArtifact(patch(`${line}\n\nChecked "Q4 brief" (brief). Nothing to fix.`))).toEqual({ id: "brief", title: "Q4 brief", artifactKind: "doc", projectSlug: "garden", updatedAt: record.updatedAt });
    expect(writtenArtifact(patch(line.slice(0, 50)))).toMatchObject({ id: "brief", title: "Q4 brief" });
    expect(writtenArtifact(patch("tool error: edit 1: find does not occur in the stored HTML"))).toBeUndefined();
    expect(writtenArtifact({ ...patch(line), isError: true })).toBeUndefined();
  });

  it("is no artifact while running, held, refused, failed, or for another step", () => {
    const { result: _result, ...running } = write();
    expect(writtenArtifact(running)).toBeUndefined();
    expect(writtenArtifact(write({ pendingId: "4" }))).toBeUndefined();
    expect(writtenArtifact(write({ isError: true }))).toBeUndefined();
    expect(writtenArtifact(write({ result: "tool error: this chat is School's, so its artifacts are not its to change" }))).toBeUndefined();
    expect(writtenArtifact(write({ name: "artifacts.get" }))).toBeUndefined();
  });

  it("shows as a card in place of the step, opened on its page or in place of the thread", () => {
    const open = vi.fn();
    const beside = vi.fn();
    const { container } = render(
      <ArtifactOpen.Provider value={{ projects: [{ slug: "garden", name: "Garden" } as never], open, beside }}>
        <ToolCall event={write()} />
      </ArtifactOpen.Provider>,
    );
    expect(container.querySelector(".toolcall")).toBeNull();
    expect(screen.getByText("Q4 brief")).toBeTruthy();
    expect(screen.getByText("Doc")).toBeTruthy();
    expect(screen.getByText("Garden")).toBeTruthy();
    expect(container.querySelector("img")!.getAttribute("src")).toContain("/api/artifacts/brief/thumb");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledWith("brief");
    fireEvent.click(screen.getByRole("button", { name: "Open here" }));
    expect(beside).toHaveBeenCalledWith("brief");
  });

  it("shows its kind's mark until a capture exists, asks once more a little later, and only Open where the chat has no room", () => {
    vi.useFakeTimers();
    let container: HTMLElement;
    try {
      ({ container } = render(<ToolCall event={write()} />));
      fireEvent.error(container.querySelector("img")!);
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector(".artifact-step-thumb svg")).not.toBeNull();
      act(() => void vi.advanceTimersByTime(THUMB_RETRY_MS));
      expect(container.querySelector("img")!.getAttribute("src")).toContain("try=1");
      fireEvent.error(container.querySelector("img")!);
      act(() => void vi.advanceTimersByTime(THUMB_RETRY_MS * 2));
      expect(container.querySelector("img")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(screen.queryByRole("button", { name: "Open here" })).toBeNull();
    window.location.hash = "";
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(window.location.hash).toBe("#/artifacts/brief");
  });
});

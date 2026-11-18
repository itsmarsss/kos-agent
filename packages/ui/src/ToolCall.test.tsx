// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolCall } from "./ToolCall.js";

afterEach(cleanup);

describe("a tool call's summary", () => {
  it("opens the file a step names on its own click, without toggling the card", () => {
    window.location.hash = "";
    const { container } = render(<ToolCall event={{ kind: "tool", name: "files.read", summary: "Read blobs/verity/blob.md.", args: {}, result: "ok" }} />);
    const link = screen.getByRole("link", { name: "blobs/verity/blob.md" });
    fireEvent.click(link);
    expect(window.location.hash).toBe("#/files/blobs%2Fverity%2Fblob.md");
    expect(container.querySelector(".toolcall-head")?.getAttribute("aria-expanded")).toBe("false");
    // Plain words stay plain.
    expect(screen.getByText(/Read/)).toBeTruthy();
  });
});

describe("a tool call's card", () => {
  const event = { kind: "tool" as const, name: "files.read", summary: "Read notes.md", args: { path: "notes.md" }, result: "ok" };

  it("opens to its body and folds it away again, its chevron turning", async () => {
    const { container } = render(<ToolCall event={event} />);
    const head = container.querySelector<HTMLButtonElement>(".toolcall-head")!;
    expect(container.querySelector(".toolcall-body")).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".toolcall-caret")?.classList.contains("is-open")).toBe(true);
    expect(container.querySelector(".toolcall-body .toolcall-body-inner")).not.toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".toolcall-caret")?.classList.contains("is-open")).toBe(false);
    // Gone once it has folded away.
    await waitFor(() => expect(container.querySelector(".toolcall-body")).toBeNull());
  });

  it("says how long a timed call took, and the wait on the owner apart", () => {
    const { container } = render(<ToolCall event={{ ...event, ms: 2_400, waitedMs: 125_000 }} />);
    expect(container.querySelector(".step-time")?.textContent).toBe("2.4s");
    expect(container.querySelector(".toolcall-waited")?.textContent).toBe("waited 2m for you");
  });

  it("says no time for a call kept before calls were timed", () => {
    const { container } = render(<ToolCall event={event} />);
    expect(container.querySelector(".step-time")).toBeNull();
    expect(container.querySelector(".toolcall-waited")).toBeNull();
  });

  it("counts a running call each second", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const running = { kind: "tool" as const, name: "shell.run", summary: "Run: make", args: {}, startedAt: 97_000 };
      const { container } = render(<ToolCall event={running} />);
      expect(container.querySelector(".step-time--live")?.textContent).toBe("3s");
      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(container.querySelector(".step-time--live")?.textContent).toBe("1m 04s");
    } finally {
      vi.useRealTimers();
    }
  });
});

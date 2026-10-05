// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickAsk } from "./QuickAsk.js";

/**
 * The side window is a window: it fades out rather than vanishing, its
 * header actions are buttons, and every edge is a handle.
 */

beforeEach(() => {
  // The live view opens the event stream on first use; jsdom has none.
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(): void {}
      close(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function open(props: Partial<Parameters<typeof QuickAsk>[0]> = {}): ReturnType<typeof render> {
  return render(<QuickAsk open onClose={() => {}} onOpen={() => {}} contextId="c1:owner" contextTitle="Main" {...props} />);
}

describe("the quick question window", () => {
  it("stays for the fade when closed, then goes", () => {
    vi.useFakeTimers();
    const view = open();
    expect(screen.getByRole("dialog")).toBeTruthy();

    view.rerender(<QuickAsk open={false} onClose={() => {}} onOpen={() => {}} contextId="c1:owner" contextTitle="Main" />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("is-closing");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has real buttons in its header and a handle on every edge", () => {
    open();
    const goTo = screen.getByRole("button", { name: "Go to chat" });
    expect(goTo.className).toContain("btn");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(document.querySelectorAll(".quickask-edge").length).toBe(8);
    for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(document.querySelector(`.quickask-edge--${edge}`)).toBeTruthy();
    }
  });

  it("asks a plain question when no chat is open", () => {
    open({ contextId: undefined, contextTitle: undefined });
    expect(screen.getByText(/plain question to KOS/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to chat" })).toBeNull();
  });
});

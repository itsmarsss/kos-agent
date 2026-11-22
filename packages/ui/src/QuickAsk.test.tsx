// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.js";
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
    expect(goTo.tagName).toBe("BUTTON");
    expect(goTo.className).toContain("head-act");
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(document.querySelectorAll(".quickask-edge").length).toBe(8);
    for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(document.querySelector(`.quickask-edge--${edge}`)).toBeTruthy();
    }
  });

  it("detaches from the open chat for a plain question, and attaches again", async () => {
    const aside = vi.spyOn(api, "aside").mockResolvedValue({ reply: "ok" });
    open();
    const context = (): string => document.querySelector(".quickask-context")?.textContent ?? "";
    expect(context()).toBe("about Main, without adding to it");
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(context()).toBe("a question on its own, not about Main");

    fireEvent.change(screen.getByPlaceholderText("Ask KOS…"), { target: { value: "what is 2+2" } });
    fireEvent.submit(screen.getByPlaceholderText("Ask KOS…").closest("form")!);
    await waitFor(() => expect(aside).toHaveBeenCalledWith("what is 2+2", undefined, []));

    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(context()).toBe("about Main, without adding to it");
  });

  it("leaves Enter to an input method while it composes, and sends on Enter after", async () => {
    const aside = vi.spyOn(api, "aside").mockResolvedValue({ reply: "ok" });
    open();
    const input = screen.getByPlaceholderText("Ask about this chat…");
    fireEvent.change(input, { target: { value: "にほん" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(aside).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(aside).toHaveBeenCalledWith("にほん", "c1:owner", []));
  });

  it("asks a plain question when no chat is open", () => {
    open({ contextId: undefined, contextTitle: undefined });
    expect(screen.getByText("a question on its own, not about any chat")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Go to chat" })).toBeNull();
  });
});

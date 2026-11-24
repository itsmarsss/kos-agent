// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANNOUNCE_GAP_MS, Announcer } from "@kos/kit";

import { dismissToast, toast, Toast, TOAST_MS, ToastHost, toastWords } from "./Toast.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const texts = (): string[] => [...document.querySelectorAll(".ops-toast-text")].map((n) => n.textContent ?? "");

describe("a toast", () => {
  it("says a reference as a reader would, never as its token", () => {
    expect(toastWords("Approved @approval:2. Fetch a web address: running now.")).toBe("Approved #2. Fetch a web address: running now.");
    expect(toastWords("Moved to @project:[Home lab]")).toBe("Moved to Home lab");
  });

  it("offers Undo when there is one, and goes once it is pressed", () => {
    const undo = vi.fn();
    render(
      <>
        <ToastHost />
        <Toast note={{ kind: "ok", text: "Archived “Groceries”.", undo }} />
      </>,
    );
    expect(texts()).toEqual(["Archived “Groceries”."]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
  });

  it("gives the focus back to where it came from once its Undo is pressed", () => {
    render(
      <>
        <button type="button">The list</button>
        <ToastHost />
        <Toast note={{ kind: "ok", text: "Moved a.md to the Trash", undo: () => undefined }} />
      </>,
    );
    const list = screen.getByRole("button", { name: "The list" });
    const undo = screen.getByRole("button", { name: "Undo" });
    list.focus();
    fireEvent.focusIn(undo, { relatedTarget: list });
    undo.focus();
    fireEvent.click(undo);
    expect(document.activeElement).toBe(list);
  });
});

describe("the toast queue", () => {
  it("shows the same words again when they are said again, each on its own timer", () => {
    render(<ToastHost />);
    act(() => void toast({ kind: "ok", text: "Saved" }));
    act(() => vi.advanceTimersByTime(TOAST_MS - 100));
    // Said again just before the first would have gone: it is shown afresh, and the first timer does not take it down.
    act(() => void toast({ kind: "ok", text: "Saved" }));
    act(() => vi.advanceTimersByTime(200));
    expect(texts()).toEqual(["Saved"]);
    act(() => vi.advanceTimersByTime(TOAST_MS));
    expect(texts()).toEqual([]);
  });

  it("stacks different notes rather than replacing one with the next", () => {
    render(<ToastHost />);
    act(() => {
      toast({ kind: "ok", text: "Approved #1" });
      toast({ kind: "info", text: "Denied #2" });
    });
    expect(texts()).toEqual(["Approved #1", "Denied #2"]);
    act(() => vi.advanceTimersByTime(TOAST_MS + 1));
  });

  it("marks a no in the quiet tone, never with the green check", () => {
    render(<ToastHost />);
    let id = 0;
    act(() => void (id = toast({ kind: "info", text: "Denied #3" })));
    const note = document.querySelector(".ops-toast")!;
    expect(note.className).toContain("ops-toast--info");
    expect(note.className).not.toContain("ops-toast--ok");
    act(() => dismissToast(id));
    expect(texts()).toEqual([]);
  });

  it("holds a page's note while it is set, once, however often the page draws it", () => {
    const { rerender } = render(
      <>
        <ToastHost />
        <Toast note={{ kind: "ok", text: "Copied" }} />
      </>,
    );
    rerender(
      <>
        <ToastHost />
        <Toast note={{ kind: "ok", text: "Copied" }} />
      </>,
    );
    act(() => vi.advanceTimersByTime(TOAST_MS * 3));
    expect(texts()).toEqual(["Copied"]);
    rerender(
      <>
        <ToastHost />
        <Toast note={null} />
      </>,
    );
    expect(texts()).toEqual([]);
  });

  it("sits over the composer when one is on screen", () => {
    const box = document.createElement("div");
    box.className = "composer";
    document.body.append(box);
    Object.defineProperty(box, "offsetParent", { get: () => document.body });
    box.getBoundingClientRect = () => ({ top: window.innerHeight - 120 }) as DOMRect;
    render(<ToastHost />);
    act(() => void toast({ kind: "ok", text: "Sent" }));
    expect((document.querySelector(".ops-toasts") as HTMLElement).style.bottom).toBe("calc(120px + 0.75rem)");
    box.remove();
  });
});

describe("a toast heard", () => {
  it("is said through the announcer, an error at once", () => {
    render(
      <>
        <Announcer />
        <ToastHost />
      </>,
    );
    act(() => void toast({ kind: "ok", text: "Approved @approval:2." }));
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Approved #2.");
    act(() => void toast({ kind: "err", text: "Could not save" }));
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(document.querySelector('[aria-live="assertive"]')?.textContent).toBe("Could not save");
    // The note itself is not a second live region speaking over the first.
    expect(document.querySelector(".ops-toast[role]")).toBeNull();
    act(() => vi.advanceTimersByTime(TOAST_MS + 1));
  });

  it("stays while its Undo has the focus, and goes its full time after", () => {
    render(<ToastHost />);
    act(() => void toast({ kind: "ok", text: "Archived “Groceries”.", undo: () => undefined }));
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => undo.focus());
    act(() => vi.advanceTimersByTime(60_000));
    expect(texts()).toContain("Archived “Groceries”.");
    act(() => undo.blur());
    act(() => vi.advanceTimersByTime(5_000));
    expect(texts()).toContain("Archived “Groceries”.");
    act(() => vi.advanceTimersByTime(1_100));
    expect(texts()).not.toContain("Archived “Groceries”.");
  });
});

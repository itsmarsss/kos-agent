// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clockWords, timeCard } from "@kos/shared";

import { MessageTime, TAPPED_MS, TimeLine, Timed } from "./ChatTime.js";

const AT = Date.UTC(2026, 10, 18, 14, 41);
const spaced = (s: string | null | undefined): string => (s ?? "").replace(/\s/g, " ");

function message(): HTMLElement {
  render(
    <Timed className="turn">
      <p>Ready when you are.</p>
      <a href="https://example.com">a link</a>
      <button type="button">Copy</button>
      <MessageTime at={AT} />
    </Timed>,
  );
  return document.querySelector<HTMLElement>(".turn")!;
}

describe("a message's own time", () => {
  afterEach(cleanup);

  it("is the clock time, with the date in full in its card on hover", () => {
    message();
    const time = document.querySelector<HTMLElement>(".msg-time")!;
    expect(spaced(time.textContent)).toBe(spaced(clockWords(AT)));
    expect(time.getAttribute("dateTime")).toBe(new Date(AT).toISOString());
    fireEvent.pointerEnter(time, { pointerType: "mouse" });
    const lines = [...document.querySelectorAll('[role="tooltip"] .md-time-card > span')].map((l) => spaced(l.textContent));
    expect(lines).toEqual(timeCard(AT / 1000).map(spaced));
  });

  it("shows while the mouse is over its message, and not after", () => {
    const turn = message();
    expect(turn.classList.contains("is-timed")).toBe(false);
    fireEvent.pointerEnter(turn, { pointerType: "mouse" });
    expect(turn.classList.contains("is-timed")).toBe(true);
    fireEvent.pointerLeave(turn, { pointerType: "mouse" });
    expect(turn.classList.contains("is-timed")).toBe(false);
  });

  it("shows while focus is inside its message, moving within it, and not once focus leaves", () => {
    const turn = message();
    const copy = screen.getByRole("button", { name: "Copy" });
    const link = screen.getByRole("link");
    fireEvent.focus(copy);
    expect(turn.classList.contains("is-timed")).toBe(true);
    fireEvent.blur(copy, { relatedTarget: link });
    expect(turn.classList.contains("is-timed")).toBe(true);
    fireEvent.blur(link, { relatedTarget: document.body });
    expect(turn.classList.contains("is-timed")).toBe(false);
  });

  it("shows on a tap where nothing hovers, until the next, but not for a tap on a link or button or a mouse's press", () => {
    const turn = message();
    fireEvent.pointerUp(screen.getByText("Ready when you are."), { pointerType: "touch" });
    expect(turn.classList.contains("is-timed")).toBe(true);
    fireEvent.pointerUp(screen.getByRole("button", { name: "Copy" }), { pointerType: "touch" });
    fireEvent.pointerUp(screen.getByRole("link"), { pointerType: "touch" });
    expect(turn.classList.contains("is-timed")).toBe(true);
    fireEvent.pointerUp(turn, { pointerType: "touch" });
    expect(turn.classList.contains("is-timed")).toBe(false);
    fireEvent.pointerUp(turn, { pointerType: "mouse" });
    expect(turn.classList.contains("is-timed")).toBe(false);
  });

  it("hides a tapped time again after a few seconds, or at a press anywhere else", () => {
    vi.useFakeTimers();
    try {
      const turn = message();
      fireEvent.pointerUp(turn, { pointerType: "touch" });
      act(() => vi.advanceTimersByTime(TAPPED_MS - 100));
      expect(turn.classList.contains("is-timed")).toBe(true);
      act(() => vi.advanceTimersByTime(200));
      expect(turn.classList.contains("is-timed")).toBe(false);
      fireEvent.pointerUp(turn, { pointerType: "touch" });
      fireEvent.pointerDown(screen.getByText("Ready when you are."));
      expect(turn.classList.contains("is-timed")).toBe(true);
      fireEvent.pointerDown(document.body);
      expect(turn.classList.contains("is-timed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the line between messages", () => {
  afterEach(cleanup);

  it("names the day, or tells the time after a pause, as text a reader reads, not a rule it skips", () => {
    render(<TimeLine mark={{ kind: "day", at: Date.now() }} />);
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText("Today").tagName).toBe("TIME");
    cleanup();
    render(<TimeLine mark={{ kind: "gap", at: AT }} />);
    expect(spaced(document.querySelector(".chat-mark")?.textContent)).toBe(spaced(clockWords(AT)));
  });

  it("says Yesterday once midnight passes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 18, 23, 59, 30));
      render(<TimeLine mark={{ kind: "day", at: new Date(2026, 10, 18, 22, 0).getTime() }} />);
      expect(document.querySelector(".chat-mark")?.textContent).toBe("Today");
      act(() => vi.advanceTimersByTime(61_000));
      expect(document.querySelector(".chat-mark")?.textContent).toBe("Yesterday");
    } finally {
      vi.useRealTimers();
    }
  });
});

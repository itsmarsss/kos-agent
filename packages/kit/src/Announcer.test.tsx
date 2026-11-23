// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { announce, ANNOUNCE_GAP_MS, Announcer } from "./Announcer.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const polite = (): Element => document.querySelector('[aria-live="polite"]')!;
const assertive = (): Element => document.querySelector('[aria-live="assertive"]')!;

describe("the announcer", () => {
  it("is two live regions from the first frame, empty until spoken into", () => {
    render(<Announcer />);
    expect(polite().getAttribute("role")).toBe("status");
    expect(assertive().getAttribute("role")).toBe("alert");
    expect(polite().textContent).toBe("");
  });

  it("says the words after a gap, politely unless told otherwise", () => {
    render(<Announcer />);
    act(() => announce("Saved"));
    expect(polite().textContent).toBe("");
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(polite().textContent).toBe("Saved");
    act(() => announce("Could not save", "assertive"));
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(assertive().textContent).toBe("Could not save");
    expect(polite().textContent).toBe("Saved");
  });

  it("empties the region first, so the same words twice are said twice", () => {
    render(<Announcer />);
    act(() => announce("Copied"));
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    act(() => announce("Copied"));
    expect(polite().textContent).toBe("");
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(polite().textContent).toBe("Copied");
  });

  it("keeps the latest of words said close together", () => {
    render(<Announcer />);
    act(() => {
      announce("Approved Fetch a page");
      announce("Denied Run a command");
    });
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(polite().textContent).toBe("Denied Run a command");
  });

  it("says nothing, and throws nothing, with no regions mounted", () => {
    expect(() => announce("Nobody hears this")).not.toThrow();
  });
});

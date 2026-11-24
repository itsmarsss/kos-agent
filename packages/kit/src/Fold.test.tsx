// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Fold, foldOf, MIN_HIDDEN_LINES, type FoldRule } from "./Fold.js";

const RULE: FoldRule = { lines: 8, pastLines: 12, pastChars: 800 };
/** jsdom lays nothing out: the body is as tall as this many 20 px lines. */
let drawnLines = 0;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => drawnLines * 20);
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => Object.defineProperty(real(el), "lineHeight", { value: "20px" }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("foldOf", () => {
  it("folds past the lines or past the characters, whichever comes first", () => {
    expect(foldOf(RULE, 13, 300)).toEqual({ folds: true, hidden: 5 });
    expect(foldOf(RULE, 11, 900)).toEqual({ folds: true, hidden: 3 });
    expect(foldOf(RULE, 12, 300).folds).toBe(false);
  });

  it("never folds to hide fewer than a few lines", () => {
    expect(foldOf(RULE, 9, 900)).toEqual({ folds: false, hidden: 1 });
    expect(foldOf(RULE, RULE.lines + MIN_HIDDEN_LINES, 900).folds).toBe(true);
  });
});

describe("Fold", () => {
  it("draws a short message whole, with no button", () => {
    drawnLines = 4;
    render(<Fold rule={RULE} chars={200}>words</Fold>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("folds a long one to its first lines and says how much is hidden", () => {
    drawnLines = 20;
    const { container } = render(<Fold rule={RULE} chars={1200} what="your message">words</Fold>);
    const button = screen.getByRole("button", { name: "Show more of your message, 12 more lines" });
    expect(button.textContent).toBe("Show more");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const body = container.querySelector<HTMLElement>(".kos-fold-body")!;
    expect(button.getAttribute("aria-controls")).toBe(body.id);
    expect(body.style.maxHeight).toBe("160px");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toBe("Show less");
    expect(body.style.maxHeight).toBe("");
  });

  it("opens when the focus reaches something under the fold", () => {
    drawnLines = 20;
    render(
      <Fold rule={RULE} chars={1200}>
        <a href="#x">a link at the end</a>
      </Fold>,
    );
    fireEvent.focus(screen.getByRole("link"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves the choice to its caller when given one", () => {
    drawnLines = 20;
    const onOpen = vi.fn();
    const { rerender } = render(<Fold rule={RULE} chars={1200} open={false} onOpen={onOpen}>words</Fold>);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith(true);
    rerender(<Fold rule={RULE} chars={1200} open onOpen={onOpen}>words</Fold>);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });
});

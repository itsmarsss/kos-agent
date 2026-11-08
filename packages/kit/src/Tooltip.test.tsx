// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timeCard } from "@kos/shared";

import { Markdown } from "./Markdown.js";
import { Tooltip } from "./Tooltip.js";

/** 2026-11-21 04:59 UTC: late on Friday the 20th in Toronto. */
const SECONDS = Date.UTC(2026, 10, 21, 4, 59) / 1000;

function chip(): HTMLElement {
  render(<Markdown text={`Due <t:${SECONDS}:R>.`} />);
  return document.querySelector<HTMLElement>(".md-time")!;
}

const card = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="tooltip"]');
const spaced = (s: string | null | undefined): string => (s ?? "").replace(/\s/g, " ");

describe("the time's hover card", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("opens at once on hover, with the date over the time, and wires itself to the chip", () => {
    const time = chip();
    expect(time.hasAttribute("title")).toBe(false);
    // No tab stop per time in a long chat.
    expect(time.tabIndex).toBe(-1);
    expect(card()).toBeNull();
    expect(time.hasAttribute("aria-describedby")).toBe(false);

    fireEvent.pointerEnter(time, { pointerType: "mouse" });
    const tip = card();
    expect(tip).not.toBeNull();
    expect(time.getAttribute("aria-describedby")).toBe(tip?.id);
    const lines = [...(tip?.querySelectorAll(".md-time-card > span") ?? [])].map((l) => spaced(l.textContent));
    expect(lines).toEqual(timeCard(SECONDS).map(spaced));

    fireEvent.pointerLeave(time, { pointerType: "mouse" });
    expect(card()).toBeNull();
  });

  it("inside a link, leaves the link the one focusable element and opens on its focus", () => {
    render(
      <a href="https://example.com">
        see{" "}
        <Tooltip tip="the card">
          <span className="inner">soon</span>
        </Tooltip>
      </a>,
    );
    const link = document.querySelector<HTMLElement>("a")!;
    expect(document.querySelector(".inner")?.hasAttribute("tabindex")).toBe(false);
    act(() => link.focus());
    expect(card()?.textContent).toBe("the card");
    act(() => link.blur());
    expect(card()).toBeNull();
  });

  it("opens on focus that lands on it and closes on blur or Escape", () => {
    const time = chip();
    act(() => time.focus());
    expect(card()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(card()).toBeNull();
    act(() => time.blur());
    act(() => time.focus());
    expect(screen.getByRole("tooltip")).toBeTruthy();
    act(() => time.blur());
    expect(card()).toBeNull();
  });

  it("closes on Escape without keeping it from what the chip sits in", () => {
    const time = chip();
    const parent = vi.fn();
    window.addEventListener("keydown", parent);
    try {
      fireEvent.pointerEnter(time, { pointerType: "mouse" });
      expect(card()).not.toBeNull();
      fireEvent.keyDown(time, { key: "Escape" });
      expect(card()).toBeNull();
      expect(parent).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", parent);
    }
  });

  it("toggles on a tap and closes on a tap away", () => {
    const time = chip();
    const tap = (): void => {
      fireEvent.pointerDown(time, { pointerType: "touch" });
      act(() => time.focus());
      fireEvent.click(time);
    };
    tap();
    expect(card()).not.toBeNull();
    tap();
    expect(card()).toBeNull();
    tap();
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    expect(card()).toBeNull();
  });

  it("sits above the chip, below it near the top, and inside the window side to side", () => {
    const box = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    let chipAt = box(500, 300, 60, 20);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("kos-tip") ? box(0, 0, 200, 50) : chipAt;
    });
    const open = (): HTMLElement => {
      const time = document.querySelector<HTMLElement>(".md-time")!;
      fireEvent.pointerEnter(time, { pointerType: "mouse" });
      return card()!;
    };
    const close = (): void => {
      fireEvent.pointerLeave(document.querySelector<HTMLElement>(".md-time")!, { pointerType: "mouse" });
    };
    chip();
    let tip = open();
    // Centred over the chip, 8px above it, its arrow on the chip's middle.
    expect([tip.style.left, tip.style.top, tip.style.getPropertyValue("--tip-arrow")]).toEqual(["430px", "242px", "100px"]);
    expect(tip.classList.contains("kos-tip--below")).toBe(false);
    close();

    chipAt = box(4, 10, 60, 20);
    tip = open();
    // At the top left: under the chip, held 8px in, the arrow still on the chip.
    expect([tip.style.left, tip.style.top, tip.style.getPropertyValue("--tip-arrow")]).toEqual(["8px", "38px", "26px"]);
    expect(tip.classList.contains("kos-tip--below")).toBe(true);
  });
});

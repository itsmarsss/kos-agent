// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { reveal, revealTop } from "./reveal.js";

describe("keeping the chosen row in view", () => {
  const view = { top: 100, height: 200 };

  it("leaves a row that already shows whole", () => {
    expect(revealTop(view, { top: 150, height: 28 }, 28)).toBeNull();
  });

  it("scrolls up to a row above, clear of the sticky head", () => {
    expect(revealTop(view, { top: 110, height: 28 }, 28)).toBe(82);
    expect(revealTop(view, { top: 20, height: 28 }, 28)).toBe(0);
  });

  it("scrolls down just far enough for a row below", () => {
    expect(revealTop(view, { top: 290, height: 28 }, 28)).toBe(118);
  });

  it("moves only the row's own scroller", () => {
    document.body.innerHTML = `<div class="finder-main"><div class="finder-list"><div class="finder-list-head"></div><div class="finder-row" id="r"></div></div></div>`;
    const main = document.querySelector<HTMLElement>(".finder-main")!;
    const row = document.getElementById("r")!;
    Object.defineProperty(main, "clientHeight", { value: 200 });
    Object.defineProperty(document.querySelector(".finder-list-head"), "offsetHeight", { value: 28 });
    main.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
    // 400px down the list while it shows 0 to 200.
    row.getBoundingClientRect = () => ({ top: 450, height: 28 }) as DOMRect;
    reveal(row);
    expect(main.scrollTop).toBe(228);
  });
});

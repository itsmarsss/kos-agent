import { describe, expect, it } from "vitest";

import { keepScroll, RESTORE_MS } from "./scrollmemory.js";

/** A window whose page is `height` tall: a scroll past its end is clamped, as a browser's is. */
function fakeWindow() {
  const target = new EventTarget();
  const frames: (() => void)[] = [];
  let now = 0;
  const win = Object.assign(target, {
    location: { hash: "#/inbox" },
    scrollY: 0,
    height: 2000,
    performance: { now: () => now },
    scrollTo(_x: number, y: number) {
      win.scrollY = Math.max(0, Math.min(y, win.height));
    },
    requestAnimationFrame(fn: () => void) {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame() {
      frames.length = 0;
    },
  });
  const scroll = (y: number): void => {
    win.scrollTo(0, y);
    win.dispatchEvent(new Event("scroll"));
  };
  const go = (hash: string, height: number, back = false): void => {
    win.location.hash = hash;
    win.height = height;
    win.scrollTo(0, win.scrollY);
    if (back) win.dispatchEvent(new Event("popstate"));
    // The browser's clamp as the page changes reaches the listener as a scroll too.
    win.dispatchEvent(new Event("scroll"));
  };
  /** Runs the waiting frames, `ms` apart. */
  const tick = (ms = 16): void => {
    now += ms;
    const due = frames.splice(0);
    for (const fn of due) fn();
  };
  return { win, scroll, go, tick };
}

describe("keepScroll", () => {
  it("puts a page back where it was once it has grown tall enough after Back", () => {
    const { win, scroll, go, tick } = fakeWindow();
    const stop = keepScroll(win as unknown as Window);
    scroll(435);
    go("#/chats/a", 300);
    go("#/inbox", 100, true);
    tick();
    expect(win.scrollY).toBe(100);
    win.height = 2000;
    tick();
    expect(win.scrollY).toBe(435);
    stop();
  });

  it("leaves a page alone when the reader moves it during the restore", () => {
    const { win, scroll, go, tick } = fakeWindow();
    const stop = keepScroll(win as unknown as Window);
    scroll(435);
    go("#/chats/a", 300);
    go("#/inbox", 100, true);
    win.dispatchEvent(new Event("touchstart"));
    win.height = 2000;
    tick();
    expect(win.scrollY).toBe(100);
    stop();
  });

  it("gives up once the page has had its time to load", () => {
    const { win, scroll, go, tick } = fakeWindow();
    const stop = keepScroll(win as unknown as Window);
    scroll(435);
    go("#/chats/a", 300);
    go("#/inbox", 100, true);
    tick(RESTORE_MS + 1);
    win.height = 2000;
    tick();
    expect(win.scrollY).toBe(100);
    stop();
  });

  it("does nothing on a link to a page, only on Back or Forward", () => {
    const { win, scroll, go, tick } = fakeWindow();
    const stop = keepScroll(win as unknown as Window);
    scroll(435);
    go("#/chats/a", 2000);
    scroll(0);
    go("#/inbox", 2000);
    tick();
    expect(win.scrollY).toBe(0);
    stop();
  });
});

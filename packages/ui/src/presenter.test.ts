import { describe, expect, it } from "vitest";

import { type Follow, clampSlide, clockElapsed, clockRunning, clockWords, followDeck, moveSlide, pauseClock, presenterKey, resetClock, resumeClock, slideAfter, startClock, unfollowed } from "./presenter.js";
import { audienceHash, audienceRoute, presentSession, readSignal } from "./presentlink.js";

describe("the presenter's place", () => {
  it("maps the keys a presenter reaches for, and Escape ends it", () => {
    for (const k of ["ArrowRight", "ArrowDown", "PageDown", " "]) expect(presenterKey(k)).toBe("next");
    for (const k of ["ArrowLeft", "ArrowUp", "PageUp"]) expect(presenterKey(k)).toBe("prev");
    expect(presenterKey(" ", true)).toBe("prev");
    expect(presenterKey("Home")).toBe("first");
    expect(presenterKey("End")).toBe("last");
    expect(presenterKey("Escape")).toBe("end");
    // The deck's own grid, notes and present keys are not the presenter's.
    for (const k of ["g", "n", "p", "f", "Enter", "a"]) expect(presenterKey(k)).toBeUndefined();
  });

  it("moves one slide at a time and stops at either end", () => {
    expect(moveSlide(0, 4, "next")).toBe(1);
    expect(moveSlide(3, 4, "next")).toBe(3);
    expect(moveSlide(0, 4, "prev")).toBe(0);
    expect(moveSlide(2, 4, "first")).toBe(0);
    expect(moveSlide(0, 4, "last")).toBe(3);
    expect(moveSlide(0, 0, "last")).toBe(0);
  });

  it("keeps a place in the deck, and knows the slide after it", () => {
    expect(clampSlide(7, 4)).toBe(3);
    expect(clampSlide(-2, 4)).toBe(0);
    expect(clampSlide(2, 0)).toBe(0);
    expect(slideAfter(2, 4)).toBe(3);
    expect(slideAfter(3, 4)).toBeUndefined();
  });
});

describe("the presenter's timer", () => {
  it("counts while it runs, holds while paused, and goes on from where it was", () => {
    let c = startClock(1_000);
    expect(clockRunning(c)).toBe(true);
    expect(clockElapsed(c, 61_000)).toBe(60_000);
    c = pauseClock(c, 61_000);
    expect(clockRunning(c)).toBe(false);
    expect(clockElapsed(c, 500_000)).toBe(60_000);
    expect(pauseClock(c, 600_000)).toBe(c);
    c = resumeClock(c, 500_000);
    expect(clockElapsed(c, 505_000)).toBe(65_000);
    expect(resumeClock(c, 900_000)).toBe(c);
  });

  it("resets to nought, running on if it ran and holding if paused", () => {
    const running = resetClock(startClock(0), 30_000);
    expect(clockElapsed(running, 32_000)).toBe(2_000);
    const paused = resetClock(pauseClock(startClock(0), 30_000), 40_000);
    expect(clockRunning(paused)).toBe(false);
    expect(clockElapsed(paused, 90_000)).toBe(0);
  });

  it("never runs backwards on a clock that steps back", () => {
    expect(clockElapsed(startClock(10_000), 9_000)).toBe(0);
  });

  it("reads as a clock does", () => {
    expect(clockWords(0)).toBe("0:00");
    expect(clockWords(5_999)).toBe("0:05");
    expect(clockWords(245_000)).toBe("4:05");
    expect(clockWords(3_723_000)).toBe("1:02:03");
    expect(clockWords(-5)).toBe("0:00");
  });
});

describe("the audience window's link", () => {
  it("hears only signals it knows, with a place that is a slide", () => {
    expect(readSignal({ type: "hello" })).toEqual({ type: "hello" });
    expect(readSignal({ type: "hello", version: 17 })).toEqual({ type: "hello", version: 17 });
    expect(readSignal({ type: "trouble", words: " It broke " })).toEqual({ type: "trouble", words: "It broke" });
    expect((readSignal({ type: "trouble", words: "x".repeat(900) }) as { words: string }).words).toHaveLength(400);
    expect(readSignal({ type: "trouble", words: 7 })).toBeUndefined();
    expect(readSignal({ type: "trouble", words: "  " })).toBeUndefined();
    expect(readSignal({ type: "go", index: 2, version: 17 })).toEqual({ type: "go", index: 2, version: 17 });
    expect(readSignal({ type: "go", index: 2, version: "17" })).toEqual({ type: "go", index: 2 });
    expect(readSignal({ type: "end", extra: 1 })).toEqual({ type: "end" });
    expect(readSignal({ type: "go", index: 3 })).toEqual({ type: "go", index: 3 });
    expect(readSignal({ type: "moved", index: 0 })).toEqual({ type: "moved", index: 0 });
    for (const bad of [null, "go", { type: "go" }, { type: "go", index: -1 }, { type: "go", index: 1.5 }, { type: "go", index: "2" }, { type: "present" }]) expect(readSignal(bad)).toBeUndefined();
  });

  it("names its window's route, and reads it back", () => {
    const session = presentSession();
    expect(session).toMatch(/^[0-9a-f]{24}$/);
    expect(presentSession()).not.toBe(session);
    expect(audienceRoute(audienceHash("pitch deck/2", session))).toEqual({ id: "pitch deck/2", session });
    for (const bad of ["#/artifacts/pitch", "#/audience/pitch", "#/audience/pitch/NOT-HEX", "#/audience/%E0%A4%A/abcdef0123"]) expect(audienceRoute(bad)).toBeUndefined();
  });
});

describe("keeping a deck frame on a slide", () => {
  /** Run the moves wanted, then the frame's reports, as they come: the gos told, and the moves taken for the frame's own. */
  const run = (start: Follow, wants: number[], reports: [number, number | null][]): { gos: number[]; moved: number[]; follow: Follow } => {
    let f = start;
    let want = wants[0]!;
    let seen = start.told ?? 0;
    let went: number | null = start.seq;
    const gos: number[] = [];
    const moved: number[] = [];
    const take = (): void => {
      const s = followDeck(f, want, seen, went);
      f = s.follow;
      if (s.go) gos.push(s.go.index);
      if (s.moved !== undefined) {
        moved.push(s.moved);
        want = s.moved;
      }
    };
    for (const w of wants) {
      want = w;
      take();
    }
    for (const [index, seq] of reports) {
      seen = index;
      went = seq;
      take();
    }
    return { gos, moved, follow: f };
  };

  it("tells a frame never told anything, even where it seems to be, and once", () => {
    let s = followDeck(unfollowed, 3, 0, 0);
    expect(s.go).toEqual({ index: 3, seq: 1 });
    // The report of handing over its bar, from before the go landed: let pass.
    s = followDeck(s.follow, 3, 0, 0);
    expect(s.go).toBeUndefined();
    expect(s.moved).toBeUndefined();
    s = followDeck(s.follow, 3, 3, 1);
    expect(s).toEqual({ follow: { told: 3, seq: 1 } });
    expect(followDeck(unfollowed, 0, 0, 0).go).toEqual({ index: 0, seq: 1 });
  });

  it("does not bounce on there and back: 3, 4, 3 before any report", () => {
    const { gos, moved, follow } = run({ told: 2, seq: 1 }, [3, 4, 3], [
      [3, 2],
      [4, 3],
      [3, 4],
    ]);
    expect(gos).toEqual([3, 4, 3]);
    expect(moved).toEqual([]);
    expect(follow).toEqual({ told: 3, seq: 4 });
  });

  it("keeps next then prev before the report, and Home pressed at startup before the first go landed", () => {
    expect(run({ told: 2, seq: 1 }, [3, 2], [[3, 2], [2, 3]]).moved).toEqual([]);
    const home = run(unfollowed, [5, 0], [[0, 0], [5, 1], [0, 2]]);
    expect(home.gos).toEqual([5, 0]);
    expect(home.moved).toEqual([]);
    expect(home.follow).toEqual({ told: 0, seq: 2 });
  });

  it("follows the frame moving on its own, after obeying or with no go at all", () => {
    // Obeyed the latest go, then a key moved it.
    expect(run({ told: 2, seq: 1 }, [2], [[3, null]]).moved).toEqual([3]);
    // The place told was out of its reach: it stopped at its end, having obeyed.
    expect(run({ told: 2, seq: 1 }, [9], [[3, 2]]).moved).toEqual([3]);
    // Followed: the place wanted is the frame's now, and nothing goes back.
    const s = followDeck({ told: 2, seq: 1 }, 2, 3, null);
    expect(followDeck(s.follow, 3, 3, null).go).toBeUndefined();
  });
});

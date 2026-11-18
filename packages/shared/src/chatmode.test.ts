import { describe, expect, it } from "vitest";

import { ASK, leftWords, liveMode, modeLabel, nextMode, parseChatMode, spanOf, untilOf } from "./chatmode.js";

const NOW = 1_700_000_000_000;

describe("chat mode", () => {
  it("cycles ask, auto and back", () => {
    expect(nextMode("ask")).toBe("auto");
    expect(nextMode("auto")).toBe("ask");
  });

  it("reads as Ask once Auto's time is up", () => {
    expect(liveMode({ mode: "auto", until: NOW + 1 }, NOW)).toEqual({ mode: "auto", until: NOW + 1 });
    expect(liveMode({ mode: "auto", until: NOW }, NOW)).toBe(ASK);
    expect(liveMode({ mode: "auto", until: "task" }, NOW).mode).toBe("auto");
    expect(liveMode(undefined, NOW)).toBe(ASK);
  });

  it("takes only a real mode off the wire", () => {
    expect(parseChatMode({ mode: "auto", until: "task", sessions: true })).toEqual({ mode: "auto", until: "task", sessions: true });
    expect(parseChatMode({ mode: "auto", until: -5, sessions: "yes" })).toEqual({ mode: "auto" });
    expect(parseChatMode({ mode: "ask", sessions: true })).toBe(ASK);
    expect(parseChatMode({ mode: "yolo" })).toBeUndefined();
    expect(parseChatMode("auto")).toBeUndefined();
  });

  it("sets and names spans", () => {
    expect(untilOf("8h", NOW)).toBe(NOW + 8 * 3_600_000);
    expect(untilOf("task", NOW)).toBe("task");
    expect(untilOf("off", NOW)).toBeUndefined();
    expect(spanOf({ mode: "auto", until: NOW })).toBe("timed");
    expect(spanOf({ mode: "auto" })).toBe("off");
  });

  it("labels the chip with what is left", () => {
    expect(modeLabel(ASK, NOW)).toBe("Ask");
    expect(modeLabel({ mode: "auto" }, NOW)).toBe("Auto");
    expect(modeLabel({ mode: "auto", until: "task" }, NOW)).toBe("Auto · this task");
    expect(modeLabel({ mode: "auto", until: NOW + 7 * 3_600_000 + 40 * 60_000 }, NOW)).toBe("Auto · 7h 40m");
    expect(modeLabel({ mode: "auto", until: NOW - 1 }, NOW)).toBe("Ask");
    expect(leftWords(30_000)).toBe("under a minute");
    expect(leftWords(45 * 60_000)).toBe("45m");
  });
});

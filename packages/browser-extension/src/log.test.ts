import { describe, expect, it, vi } from "vitest";

import { ExtensionLog, KEEP, KEEP_LOCAL_CHARS, newest } from "./log.js";
import type { Kept } from "./update.js";

/** A storage area in memory. */
function area(): Kept & { kept: Map<string, unknown> } {
  const kept = new Map<string, unknown>();
  return { kept, get: async (key) => kept.get(key), set: async (key, value) => void kept.set(key, value) };
}

const at = () => new Date("2026-11-17T10:20:30Z");

describe("the extension's log", () => {
  it("keeps every line in session storage and the newest in local storage, so a reload keeps them", async () => {
    const session = area();
    const local = area();
    const log = new ExtensionLog(session, local, at);
    log.note("kos.example: online");
    await log.save();
    expect(session.kept.get("log")).toEqual(["10:20:30 kos.example: online"]);
    expect(local.kept.get("log")).toEqual(["10:20:30 kos.example: online"]);
    // Chrome or the extension started again: session storage is empty, local storage is not.
    const after = new ExtensionLog(area(), local, at);
    after.note("reloaded");
    expect(await after.recent()).toBe("10:20:30 kos.example: online\n10:20:30 reloaded");
  });

  it("reads this session's lines over the older ones local storage kept", async () => {
    const session = area();
    const local = area();
    session.kept.set("log", ["now"]);
    local.kept.set("log", ["before the reload"]);
    expect(await new ExtensionLog(session, local, at).recent()).toBe("now");
    expect(await new ExtensionLog(area(), area(), at).recent()).toBe("Nothing logged yet.");
  });

  it("caps both: session storage by lines, local storage by size", async () => {
    vi.useFakeTimers();
    const session = area();
    const local = area();
    const log = new ExtensionLog(session, local, at);
    for (let i = 0; i < KEEP + 50; i++) log.note(`line ${i} ${"x".repeat(200)}`);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    const all = session.kept.get("log") as string[];
    expect(all).toHaveLength(KEEP);
    expect(all.at(-1)).toMatch(/^10:20:30 line 449 /);
    const kept = local.kept.get("log") as string[];
    expect(kept.join("\n").length).toBeLessThanOrEqual(KEEP_LOCAL_CHARS);
    expect(kept.at(-1)).toBe(all.at(-1));
    expect(kept.length).toBeLessThan(KEEP);
  });

  it("takes the newest lines that fit", () => {
    expect(newest(["aaaa", "bb", "c"], 6)).toEqual(["bb", "c"]);
    expect(newest(["aaaa"], 3)).toEqual([]);
  });
});

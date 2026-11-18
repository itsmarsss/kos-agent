import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SettingsStore } from "../store/settings.js";
import { Workspace } from "../store/workspace.js";
import { ACTS_ALONE_KEY, CHAT_MODES_KEY, ChatModes } from "./chatmodes.js";

describe("ChatModes", () => {
  let root: string;
  let ws: Workspace;
  let settings: SettingsStore;
  let now: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kos-modes-"));
    ws = Workspace.open(root);
    settings = new SettingsStore(ws.db);
    now = 1_000_000;
  });

  afterEach(() => {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  });

  const modes = (): ChatModes => new ChatModes(settings, () => now);

  it("keeps Auto per chat and forgets Ask", () => {
    const m = modes();
    expect(m.of("c1")).toEqual({ mode: "ask" });
    m.set("c1", { mode: "auto", sessions: true });
    expect(m.of("c1")).toEqual({ mode: "auto", sessions: true });
    expect(m.of("c2").mode).toBe("ask");
    expect(m.autoChats()).toEqual(["c1"]);
    m.set("c1", { mode: "ask" });
    expect(settings.get(CHAT_MODES_KEY)).toEqual({});
  });

  it("reads Auto past its time as Ask, and drops it", () => {
    const m = modes();
    m.set("c1", { mode: "auto", until: now + 60_000 });
    expect(m.of("c1").mode).toBe("auto");
    now += 60_000;
    expect(m.of("c1").mode).toBe("ask");
    expect(settings.get(CHAT_MODES_KEY)).toEqual({});
  });

  it("ends Auto set for this task when the chat's turn ends, and no other", () => {
    const m = modes();
    m.set("c1", { mode: "auto", until: "task" });
    m.set("c2", { mode: "auto" });
    expect(m.taskEnded("c1")).toBe(true);
    expect(m.taskEnded("c2")).toBe(false);
    expect(m.of("c1").mode).toBe("ask");
    expect(m.of("c2").mode).toBe("auto");
  });

  it("sets the chats that acted alone in the owner's Chrome back to Ask, once, naming them", () => {
    settings.set(ACTS_ALONE_KEY, ["c1", 7, "c2"]);
    const m = modes();
    expect(m.migrated).toEqual(["c1", "c2"]);
    expect(m.of("c1").mode).toBe("ask");
    expect(settings.get(ACTS_ALONE_KEY)).toBeUndefined();
    expect(modes().migrated).toEqual([]);
  });

  it("clears every chat's Auto, as the kill switch does", () => {
    const m = modes();
    m.set("c1", { mode: "auto" });
    m.set("c2", { mode: "auto", until: "task" });
    expect(m.clear()).toEqual(["c1", "c2"]);
    expect(m.autoChats()).toEqual([]);
    expect(settings.get(CHAT_MODES_KEY)).toEqual({});
  });

  it("reads every chat as Ask, and forgets its Auto, once the kill switch is thrown anywhere", () => {
    let halted = false;
    const m = new ChatModes(settings, () => now, () => halted);
    m.set("c1", { mode: "auto" });
    halted = true;
    expect(m.of("c1").mode).toBe("ask");
    expect(m.autoChats()).toEqual([]);
    halted = false;
    expect(m.of("c1").mode).toBe("ask");
    // Thrown before this boot: Auto is gone as it starts.
    m.set("c2", { mode: "auto" });
    expect(new ChatModes(settings, () => now, () => true).autoChats()).toEqual([]);
    expect(settings.get(CHAT_MODES_KEY)).toEqual({});
  });

  it("ignores a kept value it cannot read", () => {
    settings.set(CHAT_MODES_KEY, { c1: { mode: "sure" }, c2: "auto", c3: { mode: "auto", until: "later" } });
    const m = modes();
    expect(m.of("c1").mode).toBe("ask");
    expect(m.of("c2").mode).toBe("ask");
    expect(m.of("c3")).toEqual({ mode: "auto" });
  });
});

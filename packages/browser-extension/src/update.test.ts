import { describe, expect, it } from "vitest";

import { ReloadGate, readBuild, readUpdate, type UpdateNotice } from "./update.js";

const NEW = { id: "000000000002", commit: "b".repeat(40) };
const behind: UpdateNotice = { state: "behind", build: NEW, reload: true, force: false };

describe("KOS's word on this Chrome's build", () => {
  it("reads a reload only with a build to reload into", () => {
    expect(readUpdate({ t: "update", state: "behind", build: NEW, reason: "idle", action: "reload" })).toEqual(behind);
    expect(readUpdate({ t: "update", state: "behind", build: NEW, reason: "remote" })).toEqual({ ...behind, reload: false });
    expect(readUpdate({ t: "update", state: "behind", action: "reload" })).toEqual({ state: "behind", reload: false, force: false });
    expect(readUpdate({ t: "update", state: "behind", build: NEW, action: "reload", force: true })).toEqual({ ...behind, force: true });
    expect(readUpdate({ t: "update", state: "sideways" })).toBeUndefined();
    expect(readBuild({ id: "nope", commit: "" })).toBeUndefined();
    expect(readBuild({ id: NEW.id, commit: "", builtAt: 5 })).toEqual({ id: NEW.id, commit: "", builtAt: 5 });
  });
});

describe("the reload gate", () => {
  it("reloads into a newer build once nothing is going on", () => {
    const gate = new ReloadGate();
    expect(gate.due(false, undefined)).toBeUndefined();
    gate.told("kos", behind);
    expect(gate.due(false, undefined)).toEqual({ kos: "kos", build: NEW.id });
    // A session live, or an ask up for one.
    expect(gate.due(true, undefined)).toBeUndefined();
  });

  it("waits while a side panel turn runs, and reloads when it ends", () => {
    const gate = new ReloadGate();
    gate.told("kos", behind);
    gate.heard("kos", "chat.status", { chat: "chrome:owner", conversation: "chrome:owner", said: "fill the form", taken: true, command: false });
    expect(gate.due(false, undefined)).toBeUndefined();
    gate.heard("kos", "chat.status", { chat: "chrome:owner", conversation: "chrome:owner", story: "Opening the form" });
    expect(gate.due(false, undefined)).toBeUndefined();
    gate.heard("kos", "chat.status", { chat: "chrome:owner", conversation: "chrome:owner", story: null });
    expect(gate.due(false, undefined)).toEqual({ kos: "kos", build: NEW.id });
  });

  it("counts a turn over when it fails, or when the chat is shown answered, not while the owner's words still wait", () => {
    const gate = new ReloadGate();
    gate.told("kos", behind);
    const start = (): void => gate.heard("kos", "chat.status", { conversation: "c1", taken: true });
    start();
    gate.heard("kos", "chat.status", { conversation: "c1", error: "the model is down" });
    expect(gate.due(false, undefined)).toBeDefined();
    start();
    gate.heard("kos", "chat.show", { conversation: "c1", messages: [{ role: "you", text: "hi" }] });
    expect(gate.due(false, undefined)).toBeUndefined();
    gate.heard("kos", "chat.show", { conversation: "c1", messages: [{ role: "you", text: "hi" }, { role: "kos", text: "hello" }] });
    expect(gate.due(false, undefined)).toBeDefined();
    // A command's word is not a turn, and a status of the state alone changes nothing.
    gate.heard("kos", "chat.status", { conversation: "c1", taken: true, command: true });
    gate.heard("kos", "chat.status", { conversation: "c1", held: false });
    expect(gate.due(false, undefined)).toBeDefined();
  });

  it("reloads once per build: one it reloaded for already waits for the owner's Update now", () => {
    const gate = new ReloadGate();
    gate.told("kos", behind);
    expect(gate.due(false, NEW.id)).toBeUndefined();
    gate.told("kos", { ...behind, force: true });
    expect(gate.due(false, NEW.id)).toEqual({ kos: "kos", build: NEW.id });
  });

  it("forgets what a KOS said once its line goes, and a word that the build is current", () => {
    const gate = new ReloadGate();
    gate.told("kos", behind);
    gate.heard("kos", "chat.status", { conversation: "c1", taken: true });
    gate.gone("kos");
    expect(gate.due(false, undefined)).toBeUndefined();
    gate.told("kos", behind);
    expect(gate.due(false, undefined)).toBeDefined();
    gate.told("kos", { state: "current", build: NEW, reload: false, force: false });
    expect(gate.due(false, undefined)).toBeUndefined();
  });

  it("waits on a turn in any KOS's chats", () => {
    const gate = new ReloadGate();
    gate.told("home", behind);
    gate.heard("work", "chat.status", { conversation: "c9", story: "Reading" });
    expect(gate.due(false, undefined)).toBeUndefined();
  });
});

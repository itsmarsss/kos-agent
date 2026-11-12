import { describe, expect, it } from "vitest";

import { FORCED_AGAIN_MS, ReloadGate, folderHolds, readBuild, readUpdate, runningBuild, type Kept, type UpdateNotice } from "./update.js";

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

  it("reloads once per build: one it reloaded for already waits for the owner's Update now, and not within ten minutes", () => {
    const gate = new ReloadGate();
    gate.told("kos", behind);
    const at = 1_000_000;
    expect(gate.due(false, { build: NEW.id, at }, at + 60 * 60_000)).toBeUndefined();
    gate.told("kos", { ...behind, force: true });
    // A forced word that comes again soon after its reload, its answer lost, does not reload it again.
    expect(gate.due(false, { build: NEW.id, at }, at + 60_000)).toBeUndefined();
    expect(gate.due(false, { build: NEW.id, at }, at + FORCED_AGAIN_MS)).toEqual({ kos: "kos", build: NEW.id });
    expect(gate.due(false, { build: "000000000009", at }, at + 1)).toEqual({ kos: "kos", build: NEW.id });
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

/** A storage area, in memory. */
function area(): Kept & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return { values, get: async (key) => values.get(key), set: async (key, value) => void values.set(key, value) };
}

describe("the build of the code running", () => {
  it("is read from the folder once per load of the code, then kept, though the folder is rebuilt under it", async () => {
    const [session, local] = [area(), area()];
    let disk = { id: "000000000001", commit: "" };
    const read = async () => disk;
    expect(await runningBuild(session, local, read)).toEqual({ id: "000000000001", commit: "" });
    disk = { id: "000000000002", commit: "" };
    // The worker woke again in the same load: the old code is still what runs.
    expect(await runningBuild(session, local, read)).toEqual({ id: "000000000001", commit: "" });
    // Reloaded: Chrome emptied session storage, and the code is the folder's again.
    session.values.clear();
    expect(await runningBuild(session, local, read)).toEqual({ id: "000000000002", commit: "" });
    session.values.clear();
    expect(await runningBuild(session, local, async () => undefined)).toBeUndefined();
    expect(await runningBuild(session, local, read)).toBeUndefined();
  });
});

describe("the folder before a reload", () => {
  const files = (map: Record<string, string>) => async (file: string) => map[file];
  it("holds the build KOS named only with a manifest that reads and that build's stamp", async () => {
    const stamp = JSON.stringify(NEW);
    expect(await folderHolds(NEW.id, files({ "manifest.json": "{}", "build.json": stamp }))).toBe(true);
    // Mid-rebuild: the folder emptied, half written, or still the old build's.
    expect(await folderHolds(NEW.id, files({}))).toBe(false);
    expect(await folderHolds(NEW.id, files({ "manifest.json": "{", "build.json": stamp }))).toBe(false);
    expect(await folderHolds(NEW.id, files({ "manifest.json": "{}", "build.json": JSON.stringify({ id: "000000000001", commit: "" }) }))).toBe(false);
  });
});

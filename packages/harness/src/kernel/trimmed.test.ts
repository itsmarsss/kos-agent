import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { Kernel } from "./kernel.js";
import { lastEvents } from "./server.js";
import { historyEvents, type ChatEvent } from "./transcript.js";
import { saidText } from "../models/types.js";

/** A chat longer than what it keeps: each message is kept once, the oldest let go. */
describe("a chat that outgrows what it keeps", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-trimmed-"));
    const inference: Inference = {
      async generate() {
        return { content: [{ type: "text", text: "Noted." }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, model: "stub" };
      },
    };
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference, chrome: { port: 1, exists: () => false } });
    kernel.sessions.configure({ maxExchanges: 3 });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stores the owner's words once per turn after the trim starts", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Long" }).id;
    for (let i = 0; i < 6; i++) await kernel.handleMessage(`Message ${i}`, { sessionId: chat, userId: kernel.profile.ownerId, owner: true });
    const said = kernel.sessions.get(chat).map((m) => `${m.role}:${saidText(m.content).trim()}`);
    expect(said).toEqual(["user:Message 3", "assistant:Noted.", "user:Message 4", "assistant:Noted.", "user:Message 5", "assistant:Noted."]);
  });

  it("keeps what KOS let go for the owner, in one stretch above one line", async () => {
    const chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Long" }).id;
    for (let i = 0; i < 6; i++) await kernel.handleMessage(`Message ${i}`, { sessionId: chat, userId: kernel.profile.ownerId, owner: true });
    const earlier = kernel.sessions.earlier(chat);
    expect(earlier.map((e) => e.why)).toEqual(["trimmed"]);
    const events = historyEvents(earlier, kernel.sessions.get(chat));
    expect(events.map(line)).toEqual([
      "you:Message 0", "kos:Noted.", "you:Message 1", "kos:Noted.", "you:Message 2", "kos:Noted.",
      "divider:Past chat memory: what is above is kept for you, not for KOS",
      "you:Message 3", "kos:Noted.", "you:Message 4", "kos:Noted.", "you:Message 5", "kos:Noted.",
    ]);
  });
});

function line(e: ChatEvent): string {
  return e.kind === "message" ? `${e.role}:${e.text}` : `${e.kind}:${"text" in e ? e.text : ""}`;
}

describe("a long chat read from its end", () => {
  const you = (text: string): ChatEvent => ({ kind: "message", role: "you", text });
  const kos = (text: string): ChatEvent => ({ kind: "message", role: "kos", text });
  const tool: ChatEvent = { kind: "tool", name: "files.ls", summary: "List notes", args: {} };
  const chat = [you("a"), kos("A"), you("b"), tool, kos("B"), you("c"), kos("C")];

  it("gives all of a short one and says nothing came before", () => {
    expect(lastEvents(chat, 0)).toEqual({ events: chat, earlier: 0, ownerAbove: 0 });
    expect(lastEvents(chat, 20)).toEqual({ events: chat, earlier: 0, ownerAbove: 0 });
  });

  it("starts at a turn's opening, never inside a turn", () => {
    // The last 4 would open on the step; the cut goes back to the words that asked for it.
    expect(lastEvents(chat, 4)).toEqual({ events: chat.slice(2), earlier: 2, ownerAbove: 1 });
    expect(lastEvents(chat, 2)).toEqual({ events: chat.slice(5), earlier: 5, ownerAbove: 2 });
  });

  it("counts the owner's messages above the cut only from the last line a chat was set aside under", () => {
    const divider: ChatEvent = { kind: "divider", at: 1, text: "Past chat memory" };
    const set = [you("old"), kos("OLD"), divider, ...chat];
    expect(lastEvents(set, 2)).toEqual({ events: set.slice(8), earlier: 8, ownerAbove: 2 });
  });
});

describe("a turn that waited past what a chat keeps", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-trimmed-late-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), chrome: { port: 1, exists: () => false } });
    kernel.sessions.configure({ maxExchanges: 2 });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("takes its opening back from what was kept for the owner, once", () => {
    const chat = "c-late";
    const said = (text: string, at: number) => ({ role: "user" as const, content: [{ type: "text" as const, text }], at });
    const reply = (text: string, at: number) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], at });
    kernel.sessions.record(chat, [said("first", 1), reply("one", 2), said("second", 3), reply("two", 4), said("third", 5), reply("three", 6)]);
    expect(kernel.sessions.earlier(chat)[0]!.messages.map((m) => m.at)).toEqual([1, 2]);
    expect(kernel.sessions.takeBackTrimmed(chat, 1)).toBe(true);
    expect(kernel.sessions.earlier(chat)[0]!.messages.map((m) => m.at)).toEqual([2]);
    expect(kernel.sessions.takeBackTrimmed(chat, 1)).toBe(false);
  });
});

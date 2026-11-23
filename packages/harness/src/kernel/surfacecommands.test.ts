import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Inference } from "../agent/loop.js";
import { SecretsRegistry } from "../secrets/secrets.js";
import { parseChatCommand } from "./chatcommands.js";
import { Kernel } from "./kernel.js";

const usage = { inputTokens: 0, outputTokens: 0 };

/** A model that asks to run one risky call, so something waits on the owner. */
const asksOnce: Inference = {
  async generate(_task, req) {
    if (JSON.stringify(req.messages.at(-1)).includes("tool_result")) return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage, model: "stub" };
    return { content: [{ type: "tool_use", id: "t1", name: "danger.run", input: { what: "clear the cache" } }], stopReason: "tool_use", usage, model: "stub" };
  },
};

describe("commands every surface runs", () => {
  let root: string;
  let kernel: Kernel;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-cmd-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), inference: asksOnce, chrome: { port: 1, exists: () => false } });
    kernel.registry.register({ name: "danger.run", description: "d", inputSchema: { type: "object" } }, () => "cleared", { floor: "risky" });
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const owner = (): string => kernel.profile.ownerId;
  const run = async (text: string, conversationId: string, channel = "discord", asOwner = true): Promise<string> => {
    const command = parseChatCommand(text)!;
    return (await kernel.runKernelCommand(command, conversationId, owner(), channel, asOwner)).reply;
  };

  it("parses the new verbs, and refuses a mode that is not one", () => {
    expect(parseChatCommand("/mode")).toEqual({ kind: "mode" });
    expect(parseChatCommand("/mode AUTO")).toEqual({ kind: "mode", mode: "auto" });
    expect(parseChatCommand("/mode sometimes")).toEqual({ kind: "help" });
    expect(parseChatCommand("/inbox")).toEqual({ kind: "inbox" });
    expect(parseChatCommand("/run Morning brief")).toEqual({ kind: "run", job: "Morning brief" });
    expect(parseChatCommand("/run")).toEqual({ kind: "help" });
    expect(parseChatCommand("/target Taxes")).toEqual({ kind: "switch", target: "Taxes" });
    expect(parseChatCommand("/halt")).toEqual({ kind: "halt" });
    expect(parseChatCommand("/resume")).toEqual({ kind: "resume" });
    expect(parseChatCommand("/here")).toEqual({ kind: "here" });
  });

  it("shows and sets a chat's mode, the owner's alone, and never Auto from a text message", async () => {
    const chat = kernel.conversations.create({ userId: owner(), title: "Overnight" });
    expect(await run("/mode", chat.id)).toMatch(/^Ask: KOS asks you/);
    expect(await run("/mode auto", chat.id, "discord", false)).toBe("Only the owner sets a chat's mode.");
    expect(kernel.chatMode(chat.id).mode).toBe("ask");
    for (const channel of ["sms", "imessage"]) expect(await run("/mode auto", chat.id, channel), channel).toMatch(/^Setting a chat to Auto is never done from a text message/);
    expect(kernel.chatMode(chat.id).mode).toBe("ask");
    expect(await run("/mode auto", chat.id)).toMatch(/^Auto: /);
    expect(kernel.chatMode(chat.id).mode).toBe("auto");
    expect(await run("/mode ask", chat.id)).toMatch(/^Ask: /);
    expect(kernel.chatMode(chat.id).mode).toBe("ask");
  });

  it("halts from a text message, but never lifts the kill switch or runs a job from one", async () => {
    const chat = kernel.conversations.create({ userId: owner(), title: "Overnight" });
    for (const channel of ["sms", "imessage"]) expect(await run("/run Morning brief", chat.id, channel), channel).toMatch(/^Running a job now is never done/);
    for (const channel of ["sms", "imessage"]) {
      expect(await run("/halt", chat.id, channel), channel).toMatch(/^Halted/);
      expect(kernel.killSwitch.halted).toBe(true);
      kernel.killSwitch.resume();
    }
    await run("/halt", chat.id, "sms");
    for (const channel of ["sms", "imessage"]) expect(await run("/resume", chat.id, channel), channel).toMatch(/^Lifting the kill switch is never done/);
    expect(kernel.killSwitch.halted).toBe(true);
    expect(await run("/resume", chat.id, "dashboard")).toMatch(/^Resumed/);
  });

  it("throws and lifts the kill switch, which puts every chat back in Ask and holds Auto off", async () => {
    const chat = kernel.conversations.create({ userId: owner(), title: "Overnight" });
    await run("/mode auto", chat.id);
    expect(await run("/halt", chat.id, "discord", false)).toMatch(/Only the owner/);
    expect(kernel.killSwitch.halted).toBe(false);
    expect(await run("/halt", chat.id)).toMatch(/^Halted/);
    expect(kernel.killSwitch.halted).toBe(true);
    expect(kernel.chatMode(chat.id).mode).toBe("ask");
    expect(await run("/mode auto", chat.id)).toMatch(/halted/);
    expect(await run("/resume", chat.id)).toMatch(/^Resumed/);
    expect(kernel.killSwitch.halted).toBe(false);
    expect(await run("/resume", chat.id)).toBe("KOS is not halted.");
  });

  it("lists what waits on the owner in /inbox, by number and where it was asked", async () => {
    const chat = kernel.conversations.create({ userId: owner(), title: "Cache" });
    const here = kernel.conversations.create({ userId: owner(), title: "Elsewhere" });
    expect(await run("/inbox", here.id)).toBe("Nothing is waiting on you.");
    void kernel.handleMessage("clear it", { sessionId: chat.id, userId: owner(), owner: true });
    await vi.waitFor(() => expect(kernel.approvals.pending()).toHaveLength(1));
    const id = kernel.approvals.pending()[0]!.id;
    const inbox = await run("/inbox", here.id);
    expect(inbox).toContain(`@approval:${id}`);
    expect(inbox).toContain("(in Cache)");
    await kernel.deny(id, undefined, { surface: "dashboard" });
  });

  it("goes back to the surface's own chat with /here", async () => {
    const chat = kernel.conversations.create({ userId: owner(), title: "Taxes", channel: "discord" });
    kernel.conversations.setActive("discord", owner(), chat.id);
    const res = await kernel.runKernelCommand({ kind: "here" }, chat.id, owner(), "discord", true);
    expect(res.switchedTo).toBe(`discord:${owner()}`);
    expect(kernel.conversations.activeFor("discord", owner())).toBe(`discord:${owner()}`);
  });

  it("says so when /run names no job", async () => {
    const chat = kernel.conversations.create({ userId: owner(), title: "x" });
    expect(await run("/run nothing like it", chat.id)).toBe("No job matches “nothing like it”.");
  });
});

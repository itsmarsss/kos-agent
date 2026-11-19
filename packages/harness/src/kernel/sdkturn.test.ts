import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SdkChatOptions, SdkChatResult, SdkToolCall } from "../chat/sdkchat.js";
import type { ModelMessage } from "../models/types.js";

/** The SDK played by the test: it tells each call as it lands, then answers when let go. */
const sdk = vi.hoisted(() => ({ run: undefined as ((o: SdkChatOptions) => Promise<SdkChatResult>) | undefined }));

vi.mock("../chat/sdkchat.js", async (actual) => ({
  ...(await actual<typeof import("../chat/sdkchat.js")>()),
  runSdkChat: (o: SdkChatOptions) => sdk.run!(o),
}));

const { Kernel, SDK_FAILED } = await import("./kernel.js");
const { SecretsRegistry } = await import("../secrets/secrets.js");
const { BEHAVIOUR_KEY } = await import("./behaviour.js");

const call = (n: number, extra: Partial<SdkToolCall> = {}): SdkToolCall => ({ id: `sdk-t-${n}`, name: "files.read", input: { path: `${n}.md` }, result: `read ${n}`, isError: false, ...extra });
const answer = (calls: SdkToolCall[], text: string): SdkChatResult => ({ text, calls, usage: { inputTokens: 0, outputTokens: 0 }, models: [], costUSD: 0, stopped: false });

/** What a message holds, in a word: the owner's words, a call's use or result, or a reply. */
const shape = (m: ModelMessage): string =>
  m.content
    .map((b) => (b.type === "tool_use" ? `use ${b.id}` : b.type === "tool_result" ? `result ${b.toolUseId}` : b.type === "text" ? `${m.role} ${b.text}` : b.type))
    .join(",");

describe("a turn on the SDK engine", () => {
  let root: string;
  let kernel: InstanceType<typeof Kernel>;
  let chat: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kos-sdkturn-"));
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), chrome: { port: 1, exists: () => false } });
    kernel.settings.set(BEHAVIOUR_KEY, { engine: "sdk" });
    chat = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Notes" }).id;
  });

  afterEach(() => {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  });

  const turn = (text: string) => kernel.handleChannelTurn({ text, userId: kernel.profile.ownerId, channel: "dashboard", conversationId: chat });

  it("writes each step to the chat as it lands, and the reply at the end, in the order one write at the end made", async () => {
    let midTurn: string[] = [];
    sdk.run = async (o) => {
      const made = [call(1), call(2, { heard: { mark: "m1", words: [{ text: "and the third" }] } })];
      for (const c of made) o.onCall?.(c);
      midTurn = kernel.sessions.get(chat).map(shape);
      return answer(made, "Read both.");
    };
    await turn("read the notes");
    expect(midTurn).toEqual(["user read the notes", "use sdk-t-1", "result sdk-t-1", "use sdk-t-2", "result sdk-t-2"]);
    const stored = kernel.sessions.get(chat);
    expect(stored.map(shape)).toEqual([...midTurn, "assistant Read both."]);
    // The words heard with a result stay in its field.
    const heard = stored[4]!.content[0] as { heard?: unknown };
    expect(heard.heard).toEqual({ mark: "m1", words: [{ text: "and the third" }] });
  });

  it("runs the turn on the owner's reasoning model when the engine can run it, and on its own default otherwise", async () => {
    let asked: SdkChatOptions | undefined;
    sdk.run = async (o) => {
      asked = o;
      return answer([], "Done.");
    };
    // Nothing chosen: the engine's own default, not a model pinned from KOS's table.
    await turn("hello");
    expect(asked?.model).toBeUndefined();
    expect(asked?.effort).toBeUndefined();
    kernel.applyModelSettings({ reasoning: { model: "claude-opus-5-5", effort: "max" } });
    kernel.settings.set("models", { reasoning: { model: "claude-opus-5-5", effort: "max" } });
    await turn("hello again");
    expect(asked?.model).toBe("claude-opus-5-5");
    expect(asked?.effort).toBe("max");
  });

  it("answers on the engine's default when the chosen model is not on its login, and tells the owner once", async () => {
    kernel.applyModelSettings({ reasoning: { model: "claude-not-on-plan" } });
    kernel.settings.set("models", { reasoning: { model: "claude-not-on-plan" } });
    const tell = vi.spyOn(kernel.caretaker, "tell").mockImplementation(() => undefined);
    const asked: (string | undefined)[] = [];
    let thrown = true;
    sdk.run = async (o) => {
      asked.push(o.model);
      if (o.model) {
        // The engine's two ways of saying it: a failed query, or a reply that is only the complaint.
        thrown = !thrown;
        if (!thrown) throw new Error("There's an issue with the selected model (claude-not-on-plan). It may not exist or you may not have access to it.");
        return answer([], "There's an issue with the selected model (claude-not-on-plan). It may not exist or you may not have access to it.");
      }
      return answer([], "Answered.");
    };
    await turn("first");
    await turn("second");
    expect(asked).toEqual(["claude-not-on-plan", undefined, "claude-not-on-plan", undefined]);
    expect(kernel.sessions.get(chat).filter((m) => m.role === "assistant").map((m) => (m.content[0] as { text: string }).text)).toEqual(["Answered.", "Answered."]);
    expect(tell).toHaveBeenCalledTimes(1);
    expect(tell.mock.calls[0]![0]).toContain("claude-not-on-plan");
  });

  it("keeps each call's own time, where it landed, through the write at the turn's end", async () => {
    const landed = Date.now() - 60_000;
    sdk.run = async (o) => {
      const made = [call(1, { at: landed })];
      for (const c of made) o.onCall?.(c);
      return answer(made, "Read it.");
    };
    await turn("read the note");
    const stored = kernel.sessions.get(chat);
    expect(stored.map(shape)).toEqual(["user read the note", "use sdk-t-1", "result sdk-t-1", "assistant Read it."]);
    expect(stored.slice(1, 3).map((m) => m.at)).toEqual([landed, landed]);
    expect(stored[3]!.at!).toBeGreaterThan(landed + 50_000);
  });

  it("moves the steps after anything said in the chat meanwhile, where the end-of-turn write put them", async () => {
    sdk.run = async (o) => {
      o.onCall?.(call(1));
      // Another turn's words, written while this one ran.
      kernel.sessions.record(chat, [...kernel.sessions.get(chat), { role: "user", content: [{ type: "text", text: "meanwhile" }] }]);
      // A call stopped under the turn is in its result, as stopped, though it was never told.
      return answer([call(1), call(3, { result: "Stopped.", isError: true })], "Done.");
    };
    await turn("go");
    expect(kernel.sessions.get(chat).map(shape)).toEqual(["user go", "user meanwhile", "use sdk-t-1", "result sdk-t-1", "use sdk-t-3", "result sdk-t-3", "assistant Done."]);
  });

  it("gives the owner's own turn its screen steps across fresh queries, and any other turn the turn's steps alone", async () => {
    kernel.settings.set(BEHAVIOUR_KEY, { engine: "sdk", maxSteps: 30 });
    const asked: (number | undefined)[] = [];
    sdk.run = async (o) => {
      asked.push(o.turnSteps);
      expect(o.maxTurns).toBe(30);
      return answer([], "ok");
    };
    await turn("look at my screen");
    await kernel.handleMessage("from a schedule", { sessionId: chat, origin: "system" });
    expect(asked).toEqual([120, undefined]);
  });

  it("closes a turn that failed after its steps with a line of its own, so the steps do not read as still running", async () => {
    sdk.run = async (o) => {
      o.onCall?.(call(1));
      throw new Error("the SDK process exited");
    };
    await expect(turn("go")).rejects.toThrow("the SDK process exited");
    const stored = kernel.sessions.get(chat).map(shape);
    expect(stored).toEqual(["user go", "use sdk-t-1", "result sdk-t-1", `assistant ${SDK_FAILED} the SDK process exited`]);
  });

  it("tells a project's chat its folder, keeps its files there and asks before it writes elsewhere", async () => {
    const school = kernel.conversations.create({ userId: kernel.profile.ownerId, title: "Mokable", projectSlug: "school" }).id;
    let system = "";
    const results: string[] = [];
    sdk.run = async (o) => {
      system = o.system ?? "";
      for (const path of ["bu252/mokable/doc.md", "school/bu252/plan.md", "projects/school/notes.md"]) {
        results.push((await o.tools.execute("files.write", { path, content: "x" })).content);
      }
      await o.tools.execute("files.write", { path: "projects/resume/cv.md", content: "x" });
      return answer([], "Saved.");
    };
    const first = await kernel.handleChannelTurn({ text: "save the doc", userId: kernel.profile.ownerId, channel: "dashboard", conversationId: school });
    expect(system).toContain("Your files live in projects/school/");
    expect(system).toContain("workspace:<path>");
    expect(results).toEqual(["wrote projects/school/bu252/mokable/doc.md", "wrote projects/school/bu252/plan.md", "wrote projects/school/notes.md"]);
    expect(existsSync(join(root, "school"))).toBe(false);
    // Judged as the project's turn, though the call ran inside the SDK's bridge.
    expect(first.suspended).toBe(true);
    const ask = kernel.approvals.pending().find((a) => a.conversationId === school)!;
    expect(ask.reason).toBe("outside this project, in the resume project");
    expect(ask.reached).toBe(true);
    expect(ask.rule).toBeNull();
    await kernel.deny(ask.id, "owner");
    expect(existsSync(join(root, "projects", "resume", "cv.md"))).toBe(false);
  });

  it("tells a root chat nothing about a folder of its own", async () => {
    let system = "";
    sdk.run = async (o) => {
      system = o.system ?? "";
      return answer([], "Hi.");
    };
    await turn("hello");
    expect(system).not.toContain("## Your files");
  });

  it("holds a line for the chat while its turn waits on the owner, and writes it after the turn", async () => {
    sdk.run = async (o) => {
      o.onCall?.(call(1));
      await o.tools.execute("files.rm", { path: "notes.md" });
      return answer([call(1)], "Left it.");
    };
    const first = await turn("tidy up");
    expect(first.suspended).toBe(true);
    kernel.noteIn(chat, "The backup finished.");
    expect(kernel.sessions.get(chat).map(shape)).toEqual(["user tidy up", "use sdk-t-1", "result sdk-t-1"]);
    const ask = kernel.approvals.pending().find((a) => a.conversationId === chat)!;
    await kernel.deny(ask.id, "owner");
    await vi.waitFor(() => expect(kernel.sessions.get(chat).map(shape).at(-1)).toBe("assistant The backup finished."));
    expect(kernel.sessions.get(chat).map(shape)).toEqual(["user tidy up", "use sdk-t-1", "result sdk-t-1", "assistant Left it.", "assistant The backup finished."]);
  });

  it("keeps a held line across a close, and a crash, and writes it once", async () => {
    sdk.run = async (o) => {
      o.onCall?.(call(1));
      await o.tools.execute("files.rm", { path: "notes.md" });
      return answer([call(1)], "Left it.");
    };
    // Another kernel's held line, for a chat of its own, stays whatever this one keeps.
    const theirs = { role: "assistant", content: [{ type: "text", text: "Theirs." }] };
    kernel.settings.set("notes.held", { "other:owner": [theirs] });
    expect((await turn("tidy up")).suspended).toBe(true);
    kernel.noteIn(chat, "The backup finished.");
    expect(kernel.settings.get<Record<string, unknown>>("notes.held")?.["other:owner"]).toEqual([theirs]);
    kernel.settings.set("notes.held", { [chat]: kernel.settings.get<Record<string, unknown>>("notes.held")?.[chat] });
    // Kept where a crash would not lose it.
    expect(kernel.settings.get("notes.held")).toEqual({ [chat]: [{ role: "assistant", content: [{ type: "text", text: "The backup finished." }] }] });
    kernel.close();
    kernel = await Kernel.boot({ rootDir: root, secrets: new SecretsRegistry(), chrome: { port: 1, exists: () => false } });
    kernel.markInterrupted();
    const lines = kernel.sessions.get(chat).map(shape);
    expect(lines.filter((l) => l === "assistant The backup finished.")).toHaveLength(1);
    // A crash: nothing wrote it, and the next boot does.
    kernel.settings.set("notes.held", { [chat]: [{ role: "assistant", content: [{ type: "text", text: "Sent while down." }] }] });
    kernel.markInterrupted();
    expect(kernel.sessions.get(chat).map(shape).at(-1)).toBe("assistant Sent while down.");
    expect(kernel.settings.get("notes.held")).toEqual({});
  });
});

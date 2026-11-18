import { mkdtempSync, rmSync } from "node:fs";
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

const { Kernel } = await import("./kernel.js");
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
});
